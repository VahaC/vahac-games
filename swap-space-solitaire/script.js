// Swap Space Solitaire — script.js
// Prefix: swp-
// Dependencies: none.
//
// An open card solitaire of the traditional Baker's Game family: all 52 cards
// are dealt face up into 8 cascades, 4 swap slots (temporary cells) park one card
// each, and the 4 disks /dev/sda, /dev/sdb, /dev/sdc and /dev/sdd (the
// foundations: spades, hearts, diamonds, clubs) take each suit from ace to
// king.  Cascades build down in alternating colours, any card or run may go
// to an empty cascade, and a run of n cards moves only while
// n <= (free swap slots + 1) * 2 ^ (empty cascades, an empty destination not
// counted).
//
// Deals come from the game's own seeded shuffle: mulberry32 seeded with the
// deal number (1 to 999999), or with the FNV-1a hash of "swp:" + the local
// date for the daily deal.  The numbers belong to this game only and match no
// other program's deals.  There is no solver, so a deal is not guaranteed to
// be solvable, although nearly every deal of this family is.
//
// Saves (localStorage): swp-state (the tab shown and the numbered deal in
// play, with its undo history and clock), swp-stats (games played and won,
// the win streak and the best one) and swp-daily (the day's attempt, its
// result and the daily streak).  They are written on every move, when the
// tab is hidden and when the page goes away, never on a clock tick.  A save
// another open tab of the game wrote is taken over, never written over (see
// swpTakeOverSaves).

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var SWP_NAME = 'Swap Space Solitaire';
  var SWP_STATE_KEY = 'swp-state';
  var SWP_STATS_KEY = 'swp-stats';
  var SWP_DAILY_KEY = 'swp-daily';
  var SWP_VERSION = 1;

  var SWP_CASCADES = 8;
  var SWP_SUITS = 4;
  var SWP_RANKS = 13;
  var SWP_DECK = 52;
  // Positions: 0-7 the cascades, 8-11 the swap slots, 12-15 the disks.
  var SWP_SLOT0 = 8;
  var SWP_DISK0 = 12;
  var SWP_POSITIONS = 16;

  var SWP_DEAL_MAX = 999999;
  var SWP_HISTORY_MAX = 500;
  var SWP_LONG_CASCADE = 12;
  var SWP_TICK_MS = 1000;
  var SWP_TOAST_MS = 2200;
  var SWP_CONFIRM_MS = 4000;
  var SWP_DAY_MS = 86400000;
  var SWP_DAILY_EPOCH = Date.UTC(2026, 10, 1);
  // The game moves the focus only to keep the keys working: never scroll
  // the host page for it.
  var SWP_NO_SCROLL = { preventScroll: true };

  // U+FE0E asks for the text form of the suits, not the emoji.
  var SWP_SUIT_GLYPHS = ['♠︎', '♥︎', '♦︎', '♣︎'];
  var SWP_SUIT_NAMES = ['spades', 'hearts', 'diamonds', 'clubs'];
  var SWP_RANK_LABELS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var SWP_RANK_NAMES = ['ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king'];
  var SWP_SLOT_KEYS = ['Q', 'W', 'E', 'R'];
  var SWP_DISK_NAMES = ['/dev/sda', '/dev/sdb', '/dev/sdc', '/dev/sdd'];

  // Keys the game takes (see swpHandleKeydown): event.key lower-cased, or the
  // US-layout event.code on other layouts (AZERTY digits, Cyrillic letters).
  var SWP_KEY_POSITIONS = {
    '1': 0, '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6, '8': 7,
    q: 8, w: 9, e: 10, r: 11
  };
  var SWP_KEY_NAMES = /^([1-8]|[qwerfuz]|escape)$/;
  var SWP_CODE_KEYS = {
    Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
    Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8',
    KeyQ: 'q', KeyW: 'w', KeyE: 'e', KeyR: 'r', KeyF: 'f', KeyU: 'u', KeyZ: 'z'
  };

  // ── State ─────────────────────────────────────────────────────────────────

  // What the saves hold: the tab shown ('deal' or 'daily'), the numbered
  // deal's game, the daily record (null until a daily is first opened) and
  // the stats; selection is the picked card or run, never saved:
  // { src: position, n: cards (null: the whole run, as the keys pick it) }.
  var swpState = {
    mode: 'deal',
    deal: null,
    daily: null,
    stats: { played: 0, won: 0, streak: 0, best: 0 },
    selection: null
  };

  // Page handles, never saved: the elements (set by swpInit), the 16
  // position elements, the clock (its interval, the game it counts for and
  // the performance.now() it last counted from), the toast and confirmation
  // timeouts, the action waiting for a second press, whether a storage
  // warning is up, and the text of each save this tab last wrote or read
  // (by key), so a save another tab wrote since can be told from its own.
  var swpRuntime = {
    els: null,
    slots: [],
    clockId: null,
    clockGame: null,
    clockBase: 0,
    toastId: null,
    armed: null,
    armedId: null,
    warned: false,
    synced: {}
  };

  // ── Cards (no DOM) ────────────────────────────────────────────────────────
  //
  // A card is a number 0-51: suit * 13 + rank - 1, suits in the order of
  // SWP_SUIT_NAMES (hearts and diamonds are red).

  function swpHasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function swpSuit(card) {
    return Math.floor(card / SWP_RANKS);
  }

  function swpRank(card) {
    return card % SWP_RANKS + 1;
  }

  function swpIsRed(card) {
    var suit = swpSuit(card);
    return suit === 1 || suit === 2;
  }

  function swpCardText(card) {
    return SWP_RANK_LABELS[swpRank(card) - 1] + SWP_SUIT_GLYPHS[swpSuit(card)];
  }

  function swpCardName(card) {
    return SWP_RANK_NAMES[swpRank(card) - 1] + ' of ' + SWP_SUIT_NAMES[swpSuit(card)];
  }

  // Whether card may lie on onto in a cascade: one rank lower, other colour.
  function swpFits(card, onto) {
    return swpRank(card) === swpRank(onto) - 1 && swpIsRed(card) !== swpIsRed(onto);
  }

  // How many cards at the end of a list (bottom first) form a run: each one
  // fits on the card below it.
  function swpRunLength(cards) {
    var n = cards.length ? 1 : 0;
    while (n < cards.length && swpFits(cards[cards.length - n], cards[cards.length - n - 1])) {
      n++;
    }
    return n;
  }

  function swpIsCascade(pos) {
    return pos < SWP_SLOT0;
  }

  function swpIsSlot(pos) {
    return pos >= SWP_SLOT0 && pos < SWP_DISK0;
  }

  function swpIsDisk(pos) {
    return pos >= SWP_DISK0;
  }

  function swpPosName(pos) {
    if (swpIsCascade(pos)) {
      return 'cascade ' + (pos + 1);
    }
    if (swpIsSlot(pos)) {
      return 'swap' + (pos - SWP_SLOT0);
    }
    return SWP_DISK_NAMES[pos - SWP_DISK0];
  }

  // ── Deals (no DOM) ────────────────────────────────────────────────────────

  // The mulberry32 generator: a function returning numbers in [0, 1), the
  // same sequence for the same 32-bit seed.
  function swpMulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var x = a;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  // FNV-1a, 32 bits, over the UTF-16 code units of text.
  function swpHash(text) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  function swpEmptyBoard() {
    var board = { cascades: [], slots: [null, null, null, null], disks: [0, 0, 0, 0] };
    for (var i = 0; i < SWP_CASCADES; i++) {
      board.cascades.push([]);
    }
    return board;
  }

  // The deal of a seed: the deck 0-51 shuffled by Fisher-Yates (from the last
  // card down, j = floor(random * (i + 1))) and dealt one card per cascade
  // from left to right, so cascades 1-4 hold 7 cards and 5-8 hold 6.  The
  // last card dealt to a cascade is its top (exposed) card.
  function swpDeal(seed) {
    var random = swpMulberry32(seed);
    var deck = [];
    var board = swpEmptyBoard();
    for (var card = 0; card < SWP_DECK; card++) {
      deck.push(card);
    }
    for (var i = SWP_DECK - 1; i > 0; i--) {
      var j = Math.floor(random() * (i + 1));
      var swap = deck[i];
      deck[i] = deck[j];
      deck[j] = swap;
    }
    for (var k = 0; k < SWP_DECK; k++) {
      board.cascades[k % SWP_CASCADES].push(deck[k]);
    }
    return board;
  }

  // A deal with its safe cards already on the disks: how every game starts.
  function swpStartBoard(seed) {
    var board = swpDeal(seed);
    return swpApplyMoves(board, swpAutoMoves(board));
  }

  // ── Moves (no DOM) ────────────────────────────────────────────────────────
  //
  // A move is [src, dst, n]: n cards from the top of position src to dst.

  function swpCopyBoard(board) {
    return {
      cascades: board.cascades.map(function (cascade) { return cascade.slice(); }),
      slots: board.slots.slice(),
      disks: board.disks.slice()
    };
  }

  // The top n cards of a position, bottom first, or null when it holds fewer
  // (a swap slot and a disk give only one card, a disk its top card).
  function swpTakeView(board, pos, n) {
    if (swpIsCascade(pos)) {
      var cascade = board.cascades[pos];
      return n >= 1 && n <= cascade.length ? cascade.slice(cascade.length - n) : null;
    }
    if (n !== 1) {
      return null;
    }
    if (swpIsSlot(pos)) {
      var card = board.slots[pos - SWP_SLOT0];
      return card === null ? null : [card];
    }
    var count = board.disks[pos - SWP_DISK0];
    return count ? [(pos - SWP_DISK0) * SWP_RANKS + count - 1] : null;
  }

  // Free swap slots and empty cascades, an empty cascade dst not counted.
  function swpFreeSpace(board, dst) {
    var space = { free: 0, empty: 0 };
    board.slots.forEach(function (card) {
      if (card === null) {
        space.free++;
      }
    });
    board.cascades.forEach(function (cascade, pos) {
      if (!cascade.length && pos !== dst) {
        space.empty++;
      }
    });
    return space;
  }

  // The most cards one move may carry to dst: (free swap slots + 1) *
  // 2 ^ (empty cascades other than dst) for a cascade, 1 for a slot or disk.
  function swpMaxMovable(board, dst) {
    if (!swpIsCascade(dst)) {
      return 1;
    }
    var space = swpFreeSpace(board, dst);
    return (space.free + 1) * Math.pow(2, space.empty);
  }

  function swpDiskError(board, card, dst) {
    var suit = dst - SWP_DISK0;
    if (swpSuit(card) !== suit) {
      return { code: 'disk-suit', card: card, pos: dst };
    }
    var count = board.disks[suit];
    if (swpRank(card) === count + 1) {
      return null;
    }
    return { code: 'disk-order', card: card, pos: dst, need: suit * SWP_RANKS + count };
  }

  // Why moving n cards from src to dst breaks the rules, or null when it is
  // legal.  The error is { code, ... } (see swpErrorText).
  function swpMoveError(board, src, dst, n) {
    if (swpIsDisk(src)) {
      return { code: 'disk-source', pos: src };
    }
    if (src === dst) {
      return { code: 'same', pos: src };
    }
    var cards = swpTakeView(board, src, n);
    if (!cards) {
      return { code: 'missing', pos: src, n: n };
    }
    var card = cards[0];
    if (swpRunLength(cards) < n) {
      return { code: 'not-run', card: card };
    }
    if (!swpIsCascade(dst) && n > 1) {
      return { code: 'one-card', pos: dst, n: n };
    }
    if (swpIsSlot(dst)) {
      var parked = board.slots[dst - SWP_SLOT0];
      return parked === null ? null : { code: 'slot-full', pos: dst, card: parked };
    }
    if (swpIsDisk(dst)) {
      return swpDiskError(board, card, dst);
    }
    var cascade = board.cascades[dst];
    if (cascade.length && !swpFits(card, cascade[cascade.length - 1])) {
      return { code: 'stack', card: card, onto: cascade[cascade.length - 1] };
    }
    var max = swpMaxMovable(board, dst);
    return n > max ? { code: 'space', n: n, max: max, space: swpFreeSpace(board, dst) } : null;
  }

  function swpCanMove(board, src, dst, n) {
    return swpMoveError(board, src, dst, n) === null;
  }

  // The board after a move, without checking the rules (undo moves cards back
  // from the disks too).  The board passed in is left alone.
  function swpApplyMove(board, move) {
    var next = swpCopyBoard(board);
    var src = move[0];
    var dst = move[1];
    var cards = swpTakeView(next, src, move[2]);
    if (swpIsCascade(src)) {
      next.cascades[src].length -= move[2];
    } else if (swpIsSlot(src)) {
      next.slots[src - SWP_SLOT0] = null;
    } else {
      next.disks[src - SWP_DISK0] -= 1;
    }
    if (swpIsCascade(dst)) {
      next.cascades[dst] = next.cascades[dst].concat(cards);
    } else if (swpIsSlot(dst)) {
      next.slots[dst - SWP_SLOT0] = cards[0];
    } else {
      next.disks[dst - SWP_DISK0] += 1;
    }
    return next;
  }

  function swpApplyMoves(board, moves) {
    return moves.reduce(swpApplyMove, board);
  }

  // A card is safe on its disk once no card can ever need it in a cascade:
  // an ace or a 2, or a card whose two lower cards of the other colour are on
  // their disks already.
  function swpIsSafe(board, card) {
    var rank = swpRank(card);
    if (rank <= 2) {
      return true;
    }
    var red = swpIsRed(card);
    return board.disks.every(function (count, suit) {
      return swpIsRed(suit * SWP_RANKS) === red || count >= rank - 1;
    });
  }

  function swpNextAutoMove(board) {
    for (var pos = 0; pos < SWP_DISK0; pos++) {
      var cards = swpTakeView(board, pos, 1);
      if (cards) {
        var disk = SWP_DISK0 + swpSuit(cards[0]);
        if (swpCanMove(board, pos, disk, 1) && swpIsSafe(board, cards[0])) {
          return [pos, disk, 1];
        }
      }
    }
    return null;
  }

  // The moves that flush every safe top card to its disk, in order (cascades
  // first, left to right, then the swap slots), until none is left.
  function swpAutoMoves(board) {
    var moves = [];
    var current = board;
    var move = swpNextAutoMove(current);
    while (move) {
      moves.push(move);
      current = swpApplyMove(current, move);
      move = swpNextAutoMove(current);
    }
    return moves;
  }

  function swpIsWon(board) {
    return board.disks.every(function (count) { return count === SWP_RANKS; });
  }

  // Whether any legal move is left (a deadlock when not).
  function swpHasMoves(board) {
    for (var src = 0; src < SWP_DISK0; src++) {
      var run = swpIsCascade(src) ? swpRunLength(board.cascades[src]) : 1;
      for (var dst = 0; dst < SWP_POSITIONS; dst++) {
        for (var n = 1; n <= run; n++) {
          if (swpCanMove(board, src, dst, n)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  // How many cards a picked cascade sends to dst.  A cascade with cards
  // decides it: the one card of the run that fits on its top, with what lies
  // on it.  To an empty cascade the picked cards go (wanted), or for a whole
  // run picked by key (wanted null) as many as the swap space allows.  A
  // swap slot or a disk takes wanted, or 1.
  function swpResolveCount(board, src, dst, wanted) {
    if (!swpIsCascade(src) || !swpIsCascade(dst)) {
      return wanted || 1;
    }
    var cascade = board.cascades[src];
    var run = swpRunLength(cascade);
    var target = board.cascades[dst];
    if (!target.length) {
      return wanted || Math.min(run, swpMaxMovable(board, dst));
    }
    for (var n = 1; n <= run; n++) {
      if (swpFits(cascade[cascade.length - n], target[target.length - 1])) {
        return n;
      }
    }
    return wanted || 1;
  }

  // ── Texts (no DOM) ────────────────────────────────────────────────────────

  function swpPad2(number) {
    return number < 10 ? '0' + number : String(number);
  }

  // Milliseconds as m:ss; minutes keep counting past 59 (75:03).
  function swpFormatTime(ms) {
    var seconds = Math.floor(ms / 1000);
    return Math.floor(seconds / 60) + ':' + swpPad2(seconds % 60);
  }

  function swpPlural(count, word) {
    return count + ' ' + word + (count === 1 ? '' : 's');
  }

  function swpErrorText(error) {
    var code = error.code;
    if (code === 'stack') {
      var below = swpRank(error.onto) - 1;
      return swpCardText(error.card) + ' does not go on ' + swpCardText(error.onto) + ': ' + (below ?
        swpCardText(error.onto) + ' takes a ' + (swpIsRed(error.onto) ? 'black ' : 'red ') + SWP_RANK_LABELS[below - 1] + '.' :
        'nothing goes on an ace in a cascade.');
    }
    if (code === 'space') {
      return 'Not enough swap space for ' + error.n + ' cards: (' + swpPlural(error.space.free, 'free swap slot') +
        ' + 1) × 2^' + error.space.empty + ' (' + swpPlural(error.space.empty, 'empty cascade') + ') = ' + error.max + '.';
    }
    if (code === 'slot-full') {
      return swpPosName(error.pos) + ' already holds ' + swpCardText(error.card) + '.';
    }
    if (code === 'one-card') {
      return swpPosName(error.pos) + ' takes one card at a time, not ' + error.n + '.';
    }
    if (code === 'disk-order') {
      return swpCardText(error.card) + ' cannot go to ' + swpPosName(error.pos) + ' yet: it needs ' + swpCardText(error.need) + ' first.';
    }
    if (code === 'disk-suit') {
      return swpPosName(error.pos) + ' takes ' + SWP_SUIT_NAMES[error.pos - SWP_DISK0] + ' only, not ' + swpCardText(error.card) + '.';
    }
    if (code === 'not-run') {
      return swpCardText(error.card) + ' cannot move: the cards on it are not a run down in alternating colours.';
    }
    if (code === 'missing') {
      return swpPosName(error.pos) + ' has no card to move.';
    }
    if (code === 'same') {
      return 'The cards are already on ' + swpPosName(error.pos) + '.';
    }
    return 'Cards on ' + swpPosName(error.pos) + ' stay on disk.';
  }

  // The plain-text result line a Share copies, label '#5' (a daily) or
  // 'deal 48213'; score { moves, elapsed, undos, cards }.
  function swpShareText(label, result, score) {
    var time = swpFormatTime(score.elapsed);
    if (result === 'won') {
      return SWP_NAME + ' ' + label + ' ' + time + ' ' + swpPlural(score.moves, 'page fault') +
        (score.undos ? ' ' + swpPlural(score.undos, 'undo') : '');
    }
    return SWP_NAME + ' ' + label + ' gave up ' + time + ' ' + score.cards + '/52 cards';
  }

  function swpCardsOnDisk(board) {
    return board.disks.reduce(function (sum, count) { return sum + count; }, 0);
  }

  function swpScoreOf(game) {
    return { moves: game.moves, elapsed: Math.floor(game.elapsed), undos: game.undos, cards: swpCardsOnDisk(game.board) };
  }

  // A typed deal number ('48213', '#48213'), or null.
  function swpParseDealNumber(text) {
    var match = /^\s*#?\s*(\d{1,6})\s*$/.exec(String(text));
    var number = match ? parseInt(match[1], 10) : 0;
    return number >= 1 ? number : null;
  }

  // ── Daily (no DOM) ────────────────────────────────────────────────────────

  // The local calendar date of a Date as YYYY-MM-DD.
  function swpDayKey(date) {
    return date.getFullYear() + '-' + swpPad2(date.getMonth() + 1) + '-' + swpPad2(date.getDate());
  }

  // Date.UTC of a YYYY-MM-DD day, or null when it is no real date.
  function swpDayUtc(key) {
    var match = typeof key === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(key) : null;
    if (!match) {
      return null;
    }
    var year = parseInt(match[1], 10);
    var month = parseInt(match[2], 10) - 1;
    var day = parseInt(match[3], 10);
    var utc = Date.UTC(year, month, day);
    var check = new Date(utc);
    return check.getUTCFullYear() === year && check.getUTCMonth() === month && check.getUTCDate() === day ? utc : null;
  }

  // The daily number of a day: 2026-11-01 is #1.  Counted in UTC days, so a
  // daylight saving change never skips or repeats a number.
  function swpDailyNumber(key) {
    return (swpDayUtc(key) - SWP_DAILY_EPOCH) / SWP_DAY_MS + 1;
  }

  function swpDailySeed(key) {
    return swpHash('swp:' + key);
  }

  function swpToday() {
    return swpDayKey(new Date());
  }

  // The daily streak as of daily number today: it stands while the last won
  // daily is today's or yesterday's, a missed day puts it at 0.
  function swpDailyStreak(record, today) {
    return record && record.lastWon !== null && record.lastWon >= today - 1 ? record.streak : 0;
  }

  // ── Games (no DOM) ────────────────────────────────────────────────────────
  //
  // A game: { kind: 'deal' | 'daily' | 'practice', deal (the deal number, or
  // the daily number), seed, board, history (groups of moves, newest last:
  // the player's move and the cards flushed to disk after it), moves (page
  // faults), undos, elapsed (ms), started (a move was made), counted (in the
  // stats), over: null | 'won' | 'lost' }.

  function swpNewGame(kind, deal, seed) {
    return {
      kind: kind,
      deal: deal,
      seed: seed,
      board: swpStartBoard(seed),
      history: [],
      moves: 0,
      undos: 0,
      elapsed: 0,
      started: false,
      counted: false,
      over: null
    };
  }

  function swpRandomDeal() {
    return 1 + Math.floor(Math.random() * SWP_DEAL_MAX);
  }

  // ── Save checks (no DOM) ──────────────────────────────────────────────────

  function swpIsInt(value) {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
  }

  function swpCount(value, fallback) {
    return swpIsInt(value) && value >= 0 ? value : fallback;
  }

  function swpIsObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function swpIsList(value, length) {
    return Array.isArray(value) && value.length === length;
  }

  function swpParseJson(text) {
    var data;
    if (typeof text !== 'string') {
      return null;
    }
    try {
      data = JSON.parse(text);
    } catch (error) {
      return null;
    }
    return swpIsObject(data) ? data : null;
  }

  // A saved board as a clean copy, or null unless it holds 8 cascades, 4
  // swap slots and 4 disk counts (0-13) with every card exactly once.
  function swpParseBoard(raw) {
    if (!swpIsObject(raw) || !swpIsList(raw.cascades, SWP_CASCADES) || !swpIsList(raw.slots, 4) || !swpIsList(raw.disks, SWP_SUITS)) {
      return null;
    }
    var seen = [];
    var total = 0;
    function take(card) {
      if (!swpIsInt(card) || card < 0 || card >= SWP_DECK || seen[card]) {
        return false;
      }
      seen[card] = true;
      total++;
      return true;
    }
    for (var suit = 0; suit < SWP_SUITS; suit++) {
      var count = raw.disks[suit];
      if (!swpIsInt(count) || count < 0 || count > SWP_RANKS) {
        return null;
      }
      for (var rank = 0; rank < count; rank++) {
        take(suit * SWP_RANKS + rank);
      }
    }
    for (var pos = 0; pos < SWP_CASCADES; pos++) {
      if (!Array.isArray(raw.cascades[pos]) || !raw.cascades[pos].every(take)) {
        return null;
      }
    }
    for (var i = 0; i < 4; i++) {
      if (raw.slots[i] !== null && !take(raw.slots[i])) {
        return null;
      }
    }
    return total === SWP_DECK ? swpCopyBoard(raw) : null;
  }

  function swpIsMove(move) {
    return Array.isArray(move) && move.length === 3 &&
      swpIsInt(move[0]) && move[0] >= 0 && move[0] < SWP_DISK0 &&
      swpIsInt(move[1]) && move[1] >= 0 && move[1] < SWP_POSITIONS && move[1] !== move[0] &&
      swpIsInt(move[2]) && move[2] >= 1 && move[2] <= SWP_RANKS &&
      (move[2] === 1 || (swpIsCascade(move[0]) && swpIsCascade(move[1])));
  }

  // Whether the cards move put on its dst are there and its src can take them
  // back (a swap slot only when empty).
  function swpCanUndoStep(board, move) {
    return swpTakeView(board, move[1], move[2]) !== null &&
      !(swpIsSlot(move[0]) && board.slots[move[0] - SWP_SLOT0] !== null);
  }

  // The saved undo history (its newest SWP_HISTORY_MAX groups) when every
  // group can be undone in turn from board and every move, played forward
  // again from the board that gives, was legal when it was made; else [].
  function swpParseHistory(raw, board) {
    if (!Array.isArray(raw)) {
      return [];
    }
    var groups = raw.slice(-SWP_HISTORY_MAX);
    var current = board;
    var g;
    var i;
    for (g = groups.length - 1; g >= 0; g--) {
      var group = groups[g];
      if (!Array.isArray(group) || !group.length) {
        return [];
      }
      for (i = group.length - 1; i >= 0; i--) {
        var move = group[i];
        if (!swpIsMove(move) || !swpCanUndoStep(current, move)) {
          return [];
        }
        current = swpApplyMove(current, [move[1], move[0], move[2]]);
      }
    }
    for (g = 0; g < groups.length; g++) {
      for (i = 0; i < groups[g].length; i++) {
        if (!swpCanMove(current, groups[g][i][0], groups[g][i][1], groups[g][i][2])) {
          return [];
        }
        current = swpApplyMove(current, groups[g][i]);
      }
    }
    return groups.map(function (moves) {
      return moves.map(function (move) { return move.slice(); });
    });
  }

  // A saved game of one of kinds, field by field, for the given deal number
  // and seed (worked out from the save's deal or day, never read from it), or
  // null when it is no game of those kinds.  A broken board is dealt again
  // (as by Restart: the clock and the counts stay), a history that cannot be
  // undone is dropped, odd numbers become 0, and the result follows the board.
  function swpParseGame(raw, kinds, deal, seed) {
    if (!swpIsObject(raw) || kinds.indexOf(raw.kind) === -1) {
      return null;
    }
    var board = swpParseBoard(raw.board);
    var fresh = !board;
    var moves = fresh ? 0 : swpCount(raw.moves, 0);
    var started = typeof raw.started === 'boolean' ? raw.started : moves > 0;
    board = board || swpStartBoard(seed);
    return {
      kind: raw.kind,
      deal: deal,
      seed: seed,
      board: board,
      history: fresh ? [] : swpParseHistory(raw.history, board),
      moves: moves,
      undos: swpCount(raw.undos, 0),
      elapsed: typeof raw.elapsed === 'number' && isFinite(raw.elapsed) && raw.elapsed >= 0 ? raw.elapsed : 0,
      started: started,
      counted: raw.kind !== 'practice' && (typeof raw.counted === 'boolean' ? raw.counted : started),
      over: swpIsWon(board) ? 'won' : raw.over === 'lost' ? 'lost' : null
    };
  }

  // swp-state: { mode, deal }, or null when there is no save at all.  deal is
  // null when the save holds no playable numbered deal.
  function swpParseState(text) {
    var data = swpParseJson(text);
    if (!data) {
      return null;
    }
    var game = swpIsObject(data.game) ? data.game : {};
    var number = swpIsInt(game.deal) && game.deal >= 1 && game.deal <= SWP_DEAL_MAX ? game.deal : null;
    return {
      mode: data.mode === 'daily' ? 'daily' : 'deal',
      deal: number === null ? null : swpParseGame(game, ['deal'], number, number)
    };
  }

  // swp-stats, field by field: never more won than played, a best streak
  // never below the current one, a streak never above the games won.
  function swpParseStats(text) {
    var data = swpParseJson(text) || {};
    var won = swpCount(data.won, 0);
    var streak = Math.min(swpCount(data.streak, 0), won);
    return {
      played: Math.max(swpCount(data.played, 0), won),
      won: won,
      streak: streak,
      best: Math.max(swpCount(data.best, 0), streak)
    };
  }

  function swpParseScore(raw) {
    var score = swpIsObject(raw) ? raw : {};
    return {
      moves: swpCount(score.moves, 0),
      elapsed: swpCount(score.elapsed, 0),
      undos: swpCount(score.undos, 0),
      cards: Math.min(swpCount(score.cards, 0), SWP_DECK)
    };
  }

  // swp-daily, field by field, or null when there is no save at all.  The
  // streak fields survive a broken day (day null, no game then).  For a real
  // day the number and seed come from the date; a broken game is dealt
  // again (a practice game once the day has a result); a daily game's own
  // result decides the day's, and a practice game means the day was played.
  function swpParseDaily(text) {
    var data = swpParseJson(text);
    if (!data) {
      return null;
    }
    var streak = swpCount(data.streak, 0);
    var record = {
      day: null,
      number: 0,
      result: null,
      score: null,
      game: null,
      streak: streak,
      best: Math.max(swpCount(data.best, 0), streak),
      lastWon: swpIsInt(data.lastWon) ? data.lastWon : null
    };
    if (swpDayUtc(data.day) === null) {
      return record;
    }
    var number = swpDailyNumber(data.day);
    var seed = swpDailySeed(data.day);
    var result = data.result === 'won' || data.result === 'lost' ? data.result : null;
    var game = swpParseGame(data.game, ['daily', 'practice'], number, seed) ||
      swpNewGame(result ? 'practice' : 'daily', number, seed);
    if (game.kind === 'daily') {
      result = game.over;
    } else if (!result) {
      result = 'lost';
    }
    record.day = data.day;
    record.number = number;
    record.result = result;
    record.game = game;
    record.score = !result ? null : game.kind === 'daily' ? swpScoreOf(game) : swpParseScore(data.score);
    return record;
  }

  // A new day's attempt, keeping the streak of the record before it.
  function swpNewDaily(day, old) {
    var number = swpDailyNumber(day);
    return {
      day: day,
      number: number,
      result: null,
      score: null,
      game: swpNewGame('daily', number, swpDailySeed(day)),
      streak: old ? old.streak : 0,
      best: old ? old.best : 0,
      lastWon: old ? old.lastWon : null
    };
  }

  // ── Other tabs (no DOM) ───────────────────────────────────────────────────

  // This tab's stats (mine) and the swp-stats another tab saved (theirs) as
  // one: games played and won and the best streak only ever grow, so the
  // larger count wins; the streak comes from the copy with more games played
  // (theirs on a tie: it is the newer save).
  function swpMergeStats(mine, theirs) {
    return {
      played: Math.max(mine.played, theirs.played),
      won: Math.max(mine.won, theirs.won),
      streak: mine.played > theirs.played ? mine.streak : theirs.streak,
      best: Math.max(mine.best, theirs.best)
    };
  }

  // Whether the daily record another tab saved (theirs, null when there is
  // none or it is broken) is behind this tab's (mine): of an earlier daily,
  // or of the same daily without the result mine has.  Taking such a record
  // over would make a finished daily playable for a score again.
  function swpDailyBehind(mine, theirs) {
    return !!mine && (!theirs || theirs.number < mine.number ||
      (theirs.number === mine.number && theirs.result === null && mine.result !== null));
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  // Storage never stops the game: blocked site data makes even reading
  // localStorage throw, a full quota makes setItem throw.  The first failure
  // shows a warning naming the keys that are not saved.
  function swpWarnStorage(error) {
    if (swpRuntime.warned) {
      return;
    }
    swpRuntime.warned = true;
    var warning = swpRuntime.els.warning;
    warning.textContent = error.name === 'QuotaExceededError' ?
      'Browser storage is full: progress, stats and the daily attempt are not being saved (swp-state, swp-stats, swp-daily).' :
      'Browser storage is blocked: progress, stats and the daily attempt will not be saved (swp-state, swp-stats, swp-daily).';
    warning.classList.remove('swp-hidden');
  }

  function swpStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      swpWarnStorage(error);
      return null;
    }
  }

  // A write remembers its text (see swpRuntime.synced); one that fails
  // changes nothing, so the stored text still counts as this tab's.
  function swpStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      swpRuntime.synced[key] = value;
    } catch (error) {
      swpWarnStorage(error);
    }
  }

  // A read of one save, remembered as this tab's text of it.
  function swpReadSave(key) {
    var text = swpStorageGet(key);
    swpRuntime.synced[key] = text;
    return text;
  }

  // The text of a save when another tab wrote it since this tab last wrote
  // or read it (null: it was removed), else undefined.
  function swpForeignText(key) {
    var old = swpRuntime.synced[key];
    var text = swpReadSave(key);
    return text === old ? undefined : text;
  }

  function swpWriteState() {
    swpStorageSet(SWP_STATE_KEY, JSON.stringify({ v: SWP_VERSION, mode: swpState.mode, game: swpState.deal }));
  }

  function swpWriteStats() {
    swpStorageSet(SWP_STATS_KEY, JSON.stringify(swpState.stats));
  }

  // swp-daily, once a daily was opened.
  function swpWriteDaily() {
    var record = swpState.daily;
    if (record) {
      swpStorageSet(SWP_DAILY_KEY, JSON.stringify({
        v: SWP_VERSION,
        day: record.day,
        number: record.number,
        result: record.result,
        score: record.score,
        game: record.game,
        streak: record.streak,
        best: record.best,
        lastWon: record.lastWon
      }));
    }
  }

  // Writes all three saves, the running clock counted in first.  What
  // another tab saved since is taken over first, so its progress is never
  // written over (see swpTakeOverSaves).
  function swpSaveAll() {
    swpAccrue();
    swpTakeOverSaves();
    swpWriteState();
    swpWriteStats();
    swpWriteDaily();
  }

  // Another open tab of the game saved since this tab last wrote or read the
  // saves (found on a storage event, when the tab is shown again, on a tap,
  // key or button, and before every save): this tab takes those saves over,
  // so it never writes its older copy over that tab's progress.  The tab on
  // show (Deals or Daily) stays.  A save that is behind this tab's never
  // wins: a swp-state without a playable deal, a swp-daily of an earlier day
  // or of the same day without the result this tab has (a finished daily
  // stays finished), and stats with fewer games (merged count by count);
  // this tab's copy is written back then.  Returns whether the deal, the
  // daily or the stats changed here: the tap, key or button that found the
  // change is dropped then, as the board it was meant for is gone.
  function swpTakeOverSaves() {
    var stateText = swpForeignText(SWP_STATE_KEY);
    var statsText = swpForeignText(SWP_STATS_KEY);
    var dailyText = swpForeignText(SWP_DAILY_KEY);
    var saved;
    var theirs;
    var record;
    var before;
    var changed;
    if (stateText === undefined && statsText === undefined && dailyText === undefined) {
      return false;
    }
    swpStopClock();
    before = JSON.stringify([swpState.deal, swpState.daily, swpState.stats]);
    saved = swpParseState(stateText);
    if (saved && saved.deal) {
      swpState.deal = saved.deal;
    } else if (stateText !== undefined) {
      swpWriteState();
    }
    if (statsText !== undefined) {
      theirs = swpParseStats(statsText);
      swpState.stats = swpMergeStats(swpState.stats, theirs);
      if (JSON.stringify(swpState.stats) !== JSON.stringify(theirs)) {
        swpWriteStats();
      }
    }
    if (dailyText !== undefined) {
      record = swpParseDaily(dailyText);
      if (swpDailyBehind(swpState.daily, record)) {
        swpWriteDaily();
      } else {
        swpState.daily = record;
      }
    }
    changed = JSON.stringify([swpState.deal, swpState.daily, swpState.stats]) !== before;
    if (changed) {
      swpState.selection = null;
      swpDisarm();
      swpSetStatus('Progress saved in another tab of the game is shown here now. ' + swpIdleText(swpGame()));
      swpShowToast('Synced with another tab');
      swpRender();
    }
    swpSyncClock();
    return changed;
  }

  // Puts the saved games back (a new random deal when there is none) and,
  // when the daily tab was shown, opens the day's daily.
  function swpLoad() {
    var saved = swpParseState(swpReadSave(SWP_STATE_KEY));
    swpState.stats = swpParseStats(swpReadSave(SWP_STATS_KEY));
    swpState.daily = swpParseDaily(swpReadSave(SWP_DAILY_KEY));
    swpState.mode = saved ? saved.mode : 'deal';
    if (saved && saved.deal) {
      swpState.deal = saved.deal;
    } else {
      var number = swpRandomDeal();
      swpState.deal = swpNewGame('deal', number, number);
    }
    if (swpState.mode === 'daily') {
      swpEnsureDaily();
    }
  }

  // ── Game flow ─────────────────────────────────────────────────────────────

  // The game on the table: the numbered deal, or the daily record's game.
  function swpGame() {
    return swpState.mode === 'daily' ? swpState.daily.game : swpState.deal;
  }

  function swpGameLabel(game) {
    if (game.kind === 'deal') {
      return 'Deal #' + game.deal;
    }
    return 'Daily #' + game.deal + (game.kind === 'practice' ? ' practice' : '');
  }

  function swpCountStart(game) {
    if (game.kind === 'practice' || game.counted) {
      return;
    }
    game.counted = true;
    swpState.stats.played += 1;
  }

  // A counted game left unfinished (New Deal, Play, the next daily) breaks
  // the win streak.
  function swpAbandon(game) {
    if (game && game.counted && !game.over) {
      swpState.stats.streak = 0;
    }
  }

  function swpFinishDaily(record, game, result) {
    record.result = result;
    record.score = swpScoreOf(game);
    if (result === 'won') {
      record.streak = record.lastWon === record.number - 1 ? record.streak + 1 : 1;
      record.best = Math.max(record.best, record.streak);
      record.lastWon = record.number;
    } else {
      record.streak = 0;
    }
  }

  function swpFinish(game, result) {
    var stats = swpState.stats;
    game.over = result;
    if (game.kind !== 'practice') {
      swpCountStart(game);
      if (result === 'won') {
        stats.won += 1;
        stats.streak += 1;
        stats.best = Math.max(stats.best, stats.streak);
      } else {
        stats.streak = 0;
      }
    }
    if (game.kind === 'daily') {
      swpFinishDaily(swpState.daily, game, result);
    }
  }

  // Opens the day's daily: a game left open since an earlier day ends here
  // (unfinished), and the new day's attempt is written at once.
  function swpEnsureDaily() {
    var today = swpToday();
    var record = swpState.daily;
    if (record && record.day === today) {
      return;
    }
    if (record) {
      swpAbandon(record.game);
    }
    swpState.daily = swpNewDaily(today, record);
  }

  // What a finished daily says about the next one: it opens at midnight, or
  // it is open already when this daily is of an earlier day (it was left
  // open across midnight), and how to start it.
  function swpDailyNote(game) {
    if (game.kind === 'deal') {
      return '';
    }
    var today = swpDailyNumber(swpToday());
    return (game.deal < today ? ' Daily #' + today + ' is open now: press Daily to play it.' :
      ' Daily #' + (game.deal + 1) + ' opens at midnight: press Daily then to play it.') +
      ' Practice replays this deal unscored.';
  }

  function swpOverText(game) {
    var label = swpGameLabel(game);
    if (game.over === 'won') {
      return label + ' cleared: all 52 cards flushed to disk in ' + swpFormatTime(game.elapsed) +
        ' with ' + swpPlural(game.moves, 'page fault') + '.' + swpDailyNote(game);
    }
    return label + ' given up with ' + swpCardsOnDisk(game.board) + ' of 52 cards on disk.' + swpDailyNote(game);
  }

  // The status line for a game just shown.
  function swpIdleText(game) {
    var label = swpGameLabel(game);
    if (game.over) {
      return swpOverText(game);
    }
    if (!swpHasMoves(game.board)) {
      return 'Deadlock: no card can move in ' + label + '. Undo (U) or Give Up.';
    }
    if (game.started) {
      return label + ' in progress: ' + swpPlural(game.moves, 'page fault') + ' so far.';
    }
    return label + (game.kind === 'practice' ? ' (not scored)' : '') +
      ': tap a card, then tap where it goes. Flush all 52 cards to /dev/sda-sdd.';
  }

  function swpMoveText(card, move, flushed) {
    var n = move[2];
    return 'Moved ' + swpCardText(card) + (n > 1 ? ' and the ' + swpPlural(n - 1, 'card') + ' on it' : '') +
      ' to ' + swpPosName(move[1]) + '.' + (flushed ? ' ' + swpPlural(flushed, 'card') + ' flushed to disk.' : '');
  }

  // After every change: status, saves, the table and the clock.
  function swpAfterChange(text) {
    swpSetStatus(text);
    swpSaveAll();
    swpRender();
    swpSyncClock();
  }

  // Plays a legal move for the player, then flushes the safe cards.
  function swpPlayerMove(move) {
    var game = swpGame();
    var card = swpTakeView(game.board, move[0], move[2])[0];
    var board = swpApplyMove(game.board, move);
    var flushed = swpAutoMoves(board);
    var text;
    swpAccrue();
    if (!game.started) {
      game.started = true;
      swpCountStart(game);
    }
    game.board = swpApplyMoves(board, flushed);
    game.history.push([move].concat(flushed));
    if (game.history.length > SWP_HISTORY_MAX) {
      game.history.shift();
    }
    game.moves += 1;
    swpState.selection = null;
    text = swpMoveText(card, move, flushed.length);
    if (swpIsWon(game.board)) {
      swpFinish(game, 'won');
      text = swpOverText(game);
      swpShowToast(swpGameLabel(game) + ' cleared!');
    } else if (!swpHasMoves(game.board)) {
      text += ' Deadlock: no card can move. Undo (U) or Give Up.';
    }
    swpAfterChange(text);
  }

  // ── Picking and moving ────────────────────────────────────────────────────

  // The bottom card of a selection (the whole run's top card for a key pick).
  function swpSelectionCard(board, sel) {
    return swpTakeView(board, sel.src, sel.n || 1)[0];
  }

  function swpSelectText(board, pos, n) {
    var count = n === null ? swpRunLength(board.cascades[pos]) : n;
    var card = swpTakeView(board, pos, count)[0];
    return 'Selected ' + swpCardText(card) + (count > 1 ? ' and the ' + swpPlural(count - 1, 'card') + ' on it' : '') +
      ' in ' + swpPosName(pos) + ': tap where it goes.';
  }

  // Whether a tap on pos (n cards, null for a cascade's free area) can pick.
  function swpSelectable(board, pos, n) {
    if (swpIsSlot(pos)) {
      return board.slots[pos - SWP_SLOT0] !== null;
    }
    if (swpIsDisk(pos)) {
      return false;
    }
    var run = swpRunLength(board.cascades[pos]);
    return run > 0 && (n === null || n <= run);
  }

  function swpSelect(pos, n) {
    var board = swpGame().board;
    var cards = swpTakeView(board, pos, n || 1);
    swpState.selection = null;
    if (swpIsDisk(pos)) {
      swpSetStatus('Cards on ' + swpPosName(pos) + ' stay on disk.');
    } else if (!cards) {
      swpSetStatus(swpPosName(pos) + ' is empty: pick a card to move first.');
    } else if (!swpSelectable(board, pos, n)) {
      swpSetStatus(swpCardText(cards[0]) + ' is buried: only the run on top of ' + swpPosName(pos) + ' can move.');
    } else {
      swpState.selection = { src: pos, n: n };
      swpSetStatus(swpSelectText(board, pos, n));
    }
    swpRender();
  }

  // The picked card tapped again (or its cascade's key pressed again): to its
  // disk when it fits, else from a cascade to the first free swap slot.
  function swpSendAway(sel) {
    var board = swpGame().board;
    var card = swpSelectionCard(board, sel);
    var disk = SWP_DISK0 + swpSuit(card);
    var slot = board.slots.indexOf(null);
    swpState.selection = null;
    if (sel.n > 1) {
      swpSetStatus('Selection cleared.');
      swpRender();
    } else if (swpCanMove(board, sel.src, disk, 1)) {
      swpPlayerMove([sel.src, disk, 1]);
    } else if (swpIsCascade(sel.src) && slot !== -1) {
      swpPlayerMove([sel.src, SWP_SLOT0 + slot, 1]);
    } else {
      swpSetStatus(swpErrorText(swpMoveError(board, sel.src, disk, 1)) +
        (swpIsCascade(sel.src) ? ' All 4 swap slots are full.' : ''));
      swpRender();
    }
  }

  // The picked cards to dst (any disk means the card's own one).  When the
  // move breaks the rules the reason shows, and a tap on a card that can be
  // picked picks it instead.
  function swpTryMove(sel, dst, tappedN) {
    var board = swpGame().board;
    var target = swpIsDisk(dst) ? SWP_DISK0 + swpSuit(swpSelectionCard(board, sel)) : dst;
    var n = swpResolveCount(board, sel.src, target, sel.n);
    var error = swpMoveError(board, sel.src, target, n);
    var text;
    if (!error) {
      swpPlayerMove([sel.src, target, n]);
      return;
    }
    text = swpErrorText(error);
    if (swpSelectable(board, dst, tappedN)) {
      swpState.selection = { src: dst, n: tappedN };
      text += ' ' + swpSelectText(board, dst, tappedN);
    }
    swpSetStatus(text);
    swpRender();
  }

  // A tap (or a key) on position pos: index is the tapped card's place in a
  // cascade, null for the cascade's free area, a slot, a disk or a key.
  function swpTap(pos, index) {
    var game = swpGame();
    var sel = swpState.selection;
    var n = !swpIsCascade(pos) ? 1 : index === null ? null : game.board.cascades[pos].length - index;
    swpDisarm();
    if (game.over) {
      swpSetStatus(swpOverText(game));
    } else if (sel && pos === sel.src && (n === sel.n || n === null)) {
      swpSendAway(sel);
    } else if (sel && pos !== sel.src) {
      swpTryMove(sel, pos, n);
    } else {
      swpSelect(pos, n);
    }
  }

  function swpDeselect() {
    swpState.selection = null;
    swpSetStatus('Selection cleared.');
    swpRender();
  }

  // ── Buttons ───────────────────────────────────────────────────────────────

  // A second press within SWP_CONFIRM_MS confirms action; the first shows
  // text and returns false.
  function swpConfirm(action, text) {
    if (swpRuntime.armed === action) {
      swpDisarm();
      return true;
    }
    swpDisarm();
    swpRuntime.armed = action;
    swpRuntime.armedId = setTimeout(swpConfirmExpired, SWP_CONFIRM_MS);
    swpSetStatus(text);
    swpShowToast(text);
    return false;
  }

  function swpDisarm() {
    clearTimeout(swpRuntime.armedId);
    swpRuntime.armedId = null;
    swpRuntime.armed = null;
  }

  function swpConfirmExpired() {
    swpDisarm();
    swpSetStatus(swpIdleText(swpGame()));
  }

  function swpUndo() {
    var game = swpGame();
    swpDisarm();
    if (game.over) {
      swpSetStatus(swpOverText(game));
      return;
    }
    if (!game.history.length) {
      swpSetStatus(game.moves ? 'Nothing left to undo: the undo history keeps the last ' + SWP_HISTORY_MAX + ' moves.' : 'Nothing to undo yet.');
      return;
    }
    var group = game.history.pop();
    var board = game.board;
    for (var i = group.length - 1; i >= 0; i--) {
      board = swpApplyMove(board, [group[i][1], group[i][0], group[i][2]]);
    }
    game.board = board;
    game.moves = Math.max(0, game.moves - 1);
    game.undos += 1;
    swpState.selection = null;
    swpAfterChange('Undid the last move' + (group.length > 1 ? ' and the ' + swpPlural(group.length - 1, 'card') + ' flushed after it' : '') +
      ': ' + swpPlural(game.moves, 'page fault') + '.');
  }

  // Back to the deal's first layout, on a second press: Undo cannot take it
  // back.  It is the same game (also for the daily attempt): the clock keeps
  // running, and the moves taken back count as undos, so a rehearsed replay
  // never shares as a clean one.  The button is disabled before the first
  // move and once the game is over.
  function swpRestart() {
    var game = swpGame();
    var undone = game.moves;
    if (!swpConfirm('restart', 'Press Restart again to go back to the first layout of ' + swpGameLabel(game) +
        ' (' + swpPlural(undone, 'move') + ' will count as undone).')) {
      return;
    }
    game.board = swpStartBoard(game.seed);
    game.history = [];
    game.moves = 0;
    game.undos += undone;
    swpState.selection = null;
    swpAfterChange('Restarted ' + swpGameLabel(game) + ' from its first layout: ' + swpPlural(undone, 'move') +
      ' counted as undone; the clock keeps running.');
  }

  // The button is disabled once the game is over.
  function swpGiveUp() {
    var game = swpGame();
    if (!swpConfirm('give-up', 'Press Give Up again to end ' + swpGameLabel(game) + ' as a loss.')) {
      return;
    }
    swpAccrue();
    swpFinish(game, 'lost');
    swpState.selection = null;
    swpAfterChange(swpOverText(game));
  }

  // Starts deal number (New Deal, Play).  A counted deal still in play asks
  // for a second press first, then counts as a loss.  Returns whether the
  // deal started.
  function swpStartDeal(number, action, button) {
    var current = swpState.deal;
    if (current.counted && !current.over &&
        !swpConfirm(action, swpGameLabel(current) + ' is in progress: press ' + button + ' again to abandon it (it counts as a loss).')) {
      return false;
    }
    swpDisarm();
    swpAbandon(current);
    swpState.deal = swpNewGame('deal', number, number);
    swpState.mode = 'deal';
    swpState.selection = null;
    swpAfterChange(swpIdleText(swpState.deal));
    return true;
  }

  function swpNewDealClick() {
    swpStartDeal(swpRandomDeal(), 'new', 'New Deal');
  }

  function swpPlayClick() {
    var input = swpRuntime.els.dealInput;
    var number = swpParseDealNumber(input.value);
    if (number === null) {
      swpDisarm();
      swpSetStatus('Deal numbers are whole numbers from 1 to ' + SWP_DEAL_MAX + ': "' + String(input.value).trim() + '" is not one.');
    } else if (swpStartDeal(number, 'play', 'Play')) {
      input.value = '';
    }
  }

  function swpHandleDealKey(event) {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      if (!swpTakeOverSaves()) {
        swpPlayClick();
      }
    }
  }

  function swpOpenDeals() {
    swpDisarm();
    swpState.mode = 'deal';
    swpState.selection = null;
    swpAfterChange(swpIdleText(swpState.deal));
  }

  // The Daily tab, also "New Daily": the day's attempt (begun now if the
  // day has none yet), resumed or shown with its result.
  function swpOpenDaily() {
    swpDisarm();
    swpAccrue();
    swpEnsureDaily();
    swpState.mode = 'daily';
    swpState.selection = null;
    swpAfterChange(swpIdleText(swpGame()));
  }

  // An unscored replay of a finished daily.
  function swpPractice() {
    var record = swpState.daily;
    swpDisarm();
    if (swpState.mode !== 'daily' || !record.result) {
      return;
    }
    record.game = swpNewGame('practice', record.number, swpDailySeed(record.day));
    swpState.selection = null;
    swpAfterChange(swpIdleText(record.game));
  }

  function swpShowShareField(text, why) {
    var field = swpRuntime.els.shareField;
    field.value = text;
    field.classList.remove('swp-hidden');
    field.focus();
    field.select();
    swpSetStatus('Copy the result yourself (' + why + '): ' + text);
  }

  function swpCopy(text) {
    var clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      swpShowShareField(text, 'the clipboard is not available here');
      return;
    }
    try {
      clipboard.writeText(text).then(function () {
        swpShowToast('Result copied');
        swpSetStatus('Copied to the clipboard: ' + text);
      }, function () {
        swpShowShareField(text, 'the clipboard refused it');
      });
    } catch (error) {
      swpShowShareField(text, 'the clipboard refused it');
    }
  }

  // Copies the shown result: the day's scored daily on the Daily tab, the
  // finished deal on the Deals tab.
  function swpShare() {
    var record = swpState.daily;
    var game = swpGame();
    swpDisarm();
    if (swpState.mode === 'daily' && record.result) {
      swpCopy(swpShareText('#' + record.number, record.result, record.score));
    } else if (swpState.mode === 'deal' && game.over) {
      swpCopy(swpShareText('deal ' + game.deal, game.over, swpScoreOf(game)));
    } else {
      swpSetStatus('Nothing to share yet: finish ' + swpGameLabel(game) + ' first.');
    }
  }

  // ── Clock ─────────────────────────────────────────────────────────────────
  //
  // The shown game's clock runs from its first move until it ends, while the
  // tab is visible.  It adds performance.now() differences, so a throttled
  // or late interval never loses or doubles time.  A tick only shows the
  // time: the time is saved with the moves, when the tab is hidden and when
  // the page goes away, so a tab left open never writes over a newer save.

  function swpAccrue() {
    if (swpRuntime.clockId === null) {
      return;
    }
    var now = performance.now();
    swpRuntime.clockGame.elapsed += Math.max(0, now - swpRuntime.clockBase);
    swpRuntime.clockBase = now;
  }

  // Counts the running clock in and stops it (also when none runs).
  function swpStopClock() {
    swpAccrue();
    clearInterval(swpRuntime.clockId);
    swpRuntime.clockId = null;
    swpRuntime.clockGame = null;
  }

  function swpSyncClock() {
    var game = swpGame();
    var run = game.started && !game.over && document.visibilityState !== 'hidden';
    if (swpRuntime.clockId !== null && (!run || swpRuntime.clockGame !== game)) {
      swpStopClock();
    }
    if (run && swpRuntime.clockId === null) {
      swpRuntime.clockGame = game;
      swpRuntime.clockBase = performance.now();
      swpRuntime.clockId = setInterval(swpRenderTime, SWP_TICK_MS);
    }
  }

  // Hidden: the clock pauses and the game is saved.  Shown again: what other
  // tabs saved meanwhile is taken over first, then the clock goes on.
  function swpHandleVisibility() {
    if (document.visibilityState === 'hidden') {
      swpSyncClock();
      swpSaveAll();
    } else {
      swpTakeOverSaves();
      swpSyncClock();
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function swpSetStatus(text) {
    swpRuntime.els.status.textContent = text;
  }

  function swpShowToast(text) {
    var toast = swpRuntime.els.toast;
    clearTimeout(swpRuntime.toastId);
    toast.textContent = text;
    toast.classList.add('swp-show');
    swpRuntime.toastId = setTimeout(swpHideToast, SWP_TOAST_MS);
  }

  function swpHideToast() {
    swpRuntime.toastId = null;
    swpRuntime.els.toast.classList.remove('swp-show');
  }

  function swpElement(tag, className) {
    var el = document.createElement(tag);
    el.className = className;
    return el;
  }

  function swpSpan(className, text) {
    var span = swpElement('span', className);
    span.textContent = text;
    return span;
  }

  // The table's cards and slots stay out of the Tab order: Tab stops on the
  // table once and its keys play (1-8, Q W E R, F); a click, a tap or a
  // screen reader still reaches every button.
  function swpButton(className, pos, index, label) {
    var button = swpElement('button', className);
    button.type = 'button';
    button.setAttribute('tabindex', '-1');
    button.setAttribute('data-pos', String(pos));
    if (index !== null) {
      button.setAttribute('data-index', String(index));
    }
    button.setAttribute('aria-label', label);
    return button;
  }

  // The table's two rows, built once: swap slots and disks on top, then the
  // cascades.
  function swpBuildTable() {
    var top = swpElement('div', 'swp-row swp-top');
    var row = swpElement('div', 'swp-row swp-cascades');
    for (var pos = 0; pos < SWP_POSITIONS; pos++) {
      var el = swpIsCascade(pos) ? swpElement('div', 'swp-cascade') : swpButton('swp-slot', pos, null, '');
      el.setAttribute('data-pos', String(pos));
      swpRuntime.slots.push(el);
      (swpIsCascade(pos) ? row : top).appendChild(el);
    }
    swpRuntime.els.table.appendChild(top);
    swpRuntime.els.table.appendChild(row);
  }

  function swpColourClass(card) {
    return swpIsRed(card) ? 'swp-red' : 'swp-black';
  }

  function swpRenderCascade(column, board, pos, sel, target) {
    var cascade = board.cascades[pos];
    var picked = sel && sel.src === pos ? sel.n || swpRunLength(cascade) : 0;
    column.className = 'swp-cascade' + (cascade.length > SWP_LONG_CASCADE ? ' swp-long' : '') + (target ? ' swp-target' : '');
    column.textContent = '';
    if (!cascade.length) {
      var empty = swpButton('swp-slot swp-empty', pos, null, 'Cascade ' + (pos + 1) + ' (key ' + (pos + 1) + '): empty');
      empty.appendChild(swpSpan('swp-slot-label', String(pos + 1)));
      column.appendChild(empty);
    }
    for (var i = 0; i < cascade.length; i++) {
      var card = cascade[i];
      var selected = i >= cascade.length - picked;
      var button = swpButton('swp-card ' + swpColourClass(card) + (selected ? ' swp-selected' : ''), pos, i,
        swpCardName(card) + ', cascade ' + (pos + 1) + (selected ? ', selected' : ''));
      button.appendChild(swpSpan('swp-card-corner', swpCardText(card)));
      button.appendChild(swpSpan('swp-card-pip', SWP_SUIT_GLYPHS[swpSuit(card)]));
      column.appendChild(button);
    }
  }

  // A swap slot or a disk: its name, then its card (or its key / suit).
  function swpRenderSlot(el, board, pos, sel, target) {
    var disk = swpIsDisk(pos);
    var index = pos - (disk ? SWP_DISK0 : SWP_SLOT0);
    var cards = swpTakeView(board, pos, 1);
    var card = cards ? cards[0] : null;
    var name = disk ? SWP_DISK_NAMES[index] + ' (' + SWP_SUIT_NAMES[index] + ', key F)' : 'swap' + index + ' (key ' + SWP_SLOT_KEYS[index] + ')';
    el.className = 'swp-slot ' + (disk ? 'swp-disk' : 'swp-swap') +
      (card === null ? ' swp-empty' : ' swp-card ' + swpColourClass(card)) +
      (sel && sel.src === pos ? ' swp-selected' : '') + (target ? ' swp-target' : '');
    el.textContent = '';
    el.appendChild(swpSpan('swp-slot-label', disk ? SWP_DISK_NAMES[index].slice(5) : 'swap' + index));
    el.appendChild(swpSpan('swp-slot-value', card !== null ? swpCardText(card) : disk ? SWP_SUIT_GLYPHS[index] : SWP_SLOT_KEYS[index]));
    el.setAttribute('aria-label', name + ': ' + (card === null ? 'empty' : swpCardName(card)));
  }

  // The data-pos:data-index of the focused card when the focus is inside the
  // table, so a rebuilt cascade can give it back.
  function swpFocusKey() {
    var table = swpRuntime.els.table;
    var active = document.activeElement;
    if (active === table || !table.contains(active)) {
      return null;
    }
    return active.getAttribute('data-pos') + ':' + active.getAttribute('data-index');
  }

  function swpRestoreFocus(key) {
    var table = swpRuntime.els.table;
    if (key === null || table.contains(document.activeElement)) {
      return;
    }
    var buttons = table.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].getAttribute('data-pos') + ':' + buttons[i].getAttribute('data-index') === key) {
        buttons[i].focus(SWP_NO_SCROLL);
        return;
      }
    }
    table.focus(SWP_NO_SCROLL);
  }

  function swpRenderTable(game) {
    var board = game.board;
    var sel = swpState.selection;
    var focusKey = swpFocusKey();
    for (var pos = 0; pos < SWP_POSITIONS; pos++) {
      var target = !!sel && pos !== sel.src && swpCanMove(board, sel.src, pos, swpResolveCount(board, sel.src, pos, sel.n));
      if (swpIsCascade(pos)) {
        swpRenderCascade(swpRuntime.slots[pos], board, pos, sel, target);
      } else {
        swpRenderSlot(swpRuntime.slots[pos], board, pos, sel, target);
      }
    }
    swpRuntime.els.table.classList.toggle('swp-won', game.over === 'won');
    swpRestoreFocus(focusKey);
  }

  function swpRenderTime() {
    swpAccrue();
    swpRuntime.els.time.textContent = swpFormatTime(swpGame().elapsed);
  }

  function swpRenderStats(game) {
    var els = swpRuntime.els;
    var stats = swpState.stats;
    var record = swpState.daily;
    swpRenderTime();
    els.faults.textContent = String(game.moves);
    els.won.textContent = stats.won + '/' + stats.played;
    els.streak.textContent = String(stats.streak);
    els.best.textContent = String(stats.best);
    els.dailyStreak.textContent = String(swpDailyStreak(record, swpDailyNumber(swpToday())));
    els.dailyStreak.setAttribute('title', 'Best daily streak: ' + (record ? record.best : 0));
  }

  function swpRenderControls(game) {
    var els = swpRuntime.els;
    var daily = swpState.mode === 'daily';
    var record = swpState.daily;
    var finished = daily ? record.result !== null : game.over !== null;
    els.tabDeals.setAttribute('aria-pressed', String(!daily));
    els.tabDaily.setAttribute('aria-pressed', String(daily));
    els.tabDeals.classList.toggle('swp-tab-active', !daily);
    els.tabDaily.classList.toggle('swp-tab-active', daily);
    els.dealControls.classList.toggle('swp-hidden', daily);
    els.label.textContent = swpGameLabel(game) + (daily ? ' · ' + record.day : '') + (game.kind === 'practice' ? ' (not scored)' : '');
    els.undo.disabled = !!game.over || !game.history.length;
    els.restart.disabled = !!game.over || (!game.history.length && !game.moves);
    els.giveUp.disabled = !!game.over;
    els.share.classList.toggle('swp-hidden', !finished);
    els.practice.classList.toggle('swp-hidden', !daily || record.result === null);
    els.shareField.classList.add('swp-hidden');
  }

  function swpRender() {
    var game = swpGame();
    swpRenderTable(game);
    swpRenderStats(game);
    swpRenderControls(game);
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  // A click on the table: the position (and card) under it, unless another
  // tab's save was just taken over.  A click that leaves the focus outside
  // the game (Safari never focuses buttons) gives it to the table, so the
  // keys work next.
  function swpHandleTableClick(event) {
    var hit = event.target.closest('[data-pos]');
    if (!swpRuntime.els.wrapper.contains(document.activeElement)) {
      swpRuntime.els.table.focus(SWP_NO_SCROLL);
    }
    if (!hit || swpTakeOverSaves()) {
      return;
    }
    var index = hit.getAttribute('data-index');
    swpTap(parseInt(hit.getAttribute('data-pos'), 10), index === null ? null : parseInt(index, 10));
  }

  // 'q', '1', 'escape' ... for a keydown (see SWP_KEY_NAMES), or null.
  function swpKeyName(event) {
    if (typeof event.key !== 'string') {
      return null;
    }
    var key = event.key.toLowerCase();
    if (SWP_KEY_NAMES.test(key)) {
      return key;
    }
    return swpHasOwn(SWP_CODE_KEYS, event.code) ? SWP_CODE_KEYS[event.code] : null;
  }

  // The keys are the game's only while the focus is inside it, and never in
  // its text fields (the deal number, the result to copy).
  function swpOwnsKeyTarget(target) {
    return swpRuntime.els.wrapper.contains(target) && !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) &&
      target.isContentEditable !== true;
  }

  // 1-8 pick or drop on a cascade, Q W E R on a swap slot, F sends to the
  // disk, U or Ctrl+Z / Cmd+Z undo, Escape drops the pick.  Every other
  // Ctrl, Alt or Cmd shortcut, held keys, composing and keys a page script
  // already handled are left alone.  A key that finds another tab's save to
  // take over does nothing more.
  function swpHandleKeydown(event) {
    var key = swpKeyName(event);
    var command = event.ctrlKey || event.metaKey;
    if (!key || event.altKey || event.repeat || event.isComposing || event.defaultPrevented ||
        !swpOwnsKeyTarget(event.target) || command !== (key === 'z') || (key === 'z' && event.shiftKey) ||
        (key === 'escape' && !swpState.selection)) {
      return;
    }
    event.preventDefault();
    if (swpTakeOverSaves()) {
      return;
    }
    if (key === 'z' || key === 'u') {
      swpUndo();
    } else if (key === 'escape') {
      swpDeselect();
    } else if (key === 'f') {
      swpKeyDisk();
    } else {
      swpTap(SWP_KEY_POSITIONS[key], null);
    }
  }

  function swpKeyDisk() {
    var game = swpGame();
    var sel = swpState.selection;
    swpDisarm();
    if (game.over) {
      swpSetStatus(swpOverText(game));
    } else if (!sel) {
      swpSetStatus('Pick a card first: 1-8 for a cascade, Q W E R for a swap slot, then F sends it to its disk.');
    } else {
      swpTryMove(sel, SWP_DISK0, 1);
    }
  }

  // A button's action, unless the press finds another tab's save to take
  // over: the board it was meant for is gone then.
  function swpGuard(action) {
    return function () {
      if (!swpTakeOverSaves()) {
        action();
      }
    };
  }

  // A storage event (another tab wrote any key) only compares the three
  // saves with what this tab last wrote or read.
  function swpBindEvents() {
    var els = swpRuntime.els;
    els.table.addEventListener('click', swpHandleTableClick);
    els.tabDeals.addEventListener('click', swpGuard(swpOpenDeals));
    els.tabDaily.addEventListener('click', swpGuard(swpOpenDaily));
    els.newDeal.addEventListener('click', swpGuard(swpNewDealClick));
    els.playDeal.addEventListener('click', swpGuard(swpPlayClick));
    els.dealInput.addEventListener('keydown', swpHandleDealKey);
    els.undo.addEventListener('click', swpGuard(swpUndo));
    els.restart.addEventListener('click', swpGuard(swpRestart));
    els.giveUp.addEventListener('click', swpGuard(swpGiveUp));
    els.share.addEventListener('click', swpGuard(swpShare));
    els.practice.addEventListener('click', swpGuard(swpPractice));
    document.addEventListener('keydown', swpHandleKeydown);
    document.addEventListener('visibilitychange', swpHandleVisibility);
    window.addEventListener('pagehide', swpSaveAll);
    window.addEventListener('storage', swpTakeOverSaves);
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  function swpFindElements() {
    return {
      wrapper: document.getElementById('swp-wrapper'),
      table: document.getElementById('swp-table'),
      status: document.getElementById('swp-status'),
      toast: document.getElementById('swp-toast'),
      warning: document.getElementById('swp-warning'),
      label: document.getElementById('swp-label'),
      tabDeals: document.getElementById('swp-tab-deals'),
      tabDaily: document.getElementById('swp-tab-daily'),
      dealControls: document.getElementById('swp-deal-controls'),
      newDeal: document.getElementById('swp-new-deal'),
      dealInput: document.getElementById('swp-deal-input'),
      playDeal: document.getElementById('swp-play-deal'),
      undo: document.getElementById('swp-undo'),
      restart: document.getElementById('swp-restart'),
      giveUp: document.getElementById('swp-give-up'),
      share: document.getElementById('swp-share'),
      practice: document.getElementById('swp-practice'),
      shareField: document.getElementById('swp-share-field'),
      faults: document.getElementById('swp-faults'),
      time: document.getElementById('swp-time'),
      won: document.getElementById('swp-won'),
      streak: document.getElementById('swp-streak'),
      best: document.getElementById('swp-best'),
      dailyStreak: document.getElementById('swp-daily-streak')
    };
  }

  // Runs once; a second call changes nothing.
  function swpInit() {
    if (swpRuntime.els) {
      return;
    }
    swpRuntime.els = swpFindElements();
    swpBuildTable();
    swpBindEvents();
    swpLoad();
    swpAfterChange(swpIdleText(swpGame()));
  }

  // Node (tests): export only, no init and no timers.  Browser: init once the
  // markup is there.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      swpState: swpState,
      swpInit: swpInit,
      swpMulberry32: swpMulberry32,
      swpHash: swpHash,
      swpDeal: swpDeal,
      swpStartBoard: swpStartBoard,
      swpTakeView: swpTakeView,
      swpFits: swpFits,
      swpRunLength: swpRunLength,
      swpMaxMovable: swpMaxMovable,
      swpMoveError: swpMoveError,
      swpCanMove: swpCanMove,
      swpApplyMove: swpApplyMove,
      swpApplyMoves: swpApplyMoves,
      swpIsSafe: swpIsSafe,
      swpAutoMoves: swpAutoMoves,
      swpIsWon: swpIsWon,
      swpHasMoves: swpHasMoves,
      swpResolveCount: swpResolveCount,
      swpCardText: swpCardText,
      swpCardName: swpCardName,
      swpErrorText: swpErrorText,
      swpFormatTime: swpFormatTime,
      swpShareText: swpShareText,
      swpScoreOf: swpScoreOf,
      swpParseDealNumber: swpParseDealNumber,
      swpDayKey: swpDayKey,
      swpDayUtc: swpDayUtc,
      swpDailyNumber: swpDailyNumber,
      swpDailySeed: swpDailySeed,
      swpDailyStreak: swpDailyStreak,
      swpMergeStats: swpMergeStats,
      swpDailyBehind: swpDailyBehind,
      swpNewGame: swpNewGame,
      swpParseBoard: swpParseBoard,
      swpParseHistory: swpParseHistory,
      swpParseGame: swpParseGame,
      swpParseState: swpParseState,
      swpParseStats: swpParseStats,
      swpParseDaily: swpParseDaily
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', swpInit);
  } else {
    swpInit();
  }
})();
