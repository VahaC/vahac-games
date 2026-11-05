// Cyberpunk Wordle — script.js
// Prefix: wrd-
// Dependencies: none.
//
// Sections: constants, word list, state, game rules (no DOM), saved state,
// elements and rendering, storage and other tabs, timer, game flow, input,
// init and start-up, Node exports.
(function () {
  'use strict';

  // --- Constants -----------------------------------------------------------

  var WRD_STORAGE_KEY = 'wrd-state';
  var WRD_WORD_LENGTH = 5;
  var WRD_MAX_GUESSES = 6;
  var WRD_TICK_MS = 1000;
  var WRD_WORD_RE = /^[A-Z]{5}$/;
  var WRD_PARTIAL_RE = /^[A-Z]{0,5}$/;
  var WRD_LETTER_RE = /^[A-Z]$/;
  var WRD_KEY_ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
  var WRD_ENTER = 'ENTER';
  var WRD_BACKSPACE = 'BACKSPACE';
  var WRD_BACKSPACE_LABEL = '⌫';

  var WRD_TEXT = {
    newGame: 'New game started',
    tooShort: 'Enter a 5-letter word',
    won: 'You win!',
    lost: 'Game over! Word: '
  };

  var WRD_IDS = {
    board: 'wrd-board',
    keyboard: 'wrd-keyboard',
    toast: 'wrd-toast',
    timer: 'wrd-timer',
    wins: 'wrd-games-won',
    newGame: 'wrd-new-game',
    restart: 'wrd-restart-game'
  };

  // --- Word list -----------------------------------------------------------
  // The possible answers.  Repeated entries are intended: they weight the draw.

  var wrdWords = [
    'CRANE', 'SLATE', 'BRINE', 'STONE', 'SHARE', 'GRACE', 'PLANT', 'TRACK', 'SWORD',
    'APPLE', 'BRAVE', 'CLOUD', 'DRIVE', 'EARTH', 'FAITH', 'GIANT', 'HEART', 'MAGIC',
    'LEMON', 'POWER', 'RIVER', 'SMILE', 'TRUST', 'UNITY', 'VOICE', 'WORLD', 'YEAST',
    'ZEBRA', 'ALERT', 'BLEND', 'CHAIR', 'DREAM', 'ENJOY', 'FROST', 'HONEY', 'INNER',
    'JELLY', 'LASER', 'METAL', 'NIGHT', 'OPERA', 'PEARL', 'QUEST', 'RANGE', 'SHINE',
    'TEACH', 'URBAN', 'VIVID', 'WATER', 'YOUTH', 'ANGEL', 'BLADE', 'CROWN', 'DEPTH',
    'ELITE', 'FLAME', 'GHOST', 'HUMAN', 'INDEX', 'LEVEL', 'MONEY', 'NOBLE', 'ORDER',
    'PEACE', 'ROUTE', 'SOLID', 'THEME', 'UNDER', 'VALUE', 'WATCH', 'YIELD', 'ACORN',
    'BASIC', 'CABLE', 'DELTA', 'EAGER', 'FANCY', 'GLASS', 'HABIT', 'IMAGE', 'JUICE',
    'LUNCH', 'MOTOR', 'NORTH', 'OFFER', 'PAUSE', 'QUILT', 'RATIO', 'SHARP', 'TOWER',
    'USAGE', 'VIRAL', 'WHEEL', 'YACHT', 'ADAPT', 'BLOOM', 'CLEAN', 'DRINK', 'ELDER',
    'FLOOD', 'GRIND', 'HUMOR', 'INPUT', 'JUDGE', 'LEARN', 'MIGHT', 'NURSE', 'PRIME',
    'QUAKE', 'ROCKY', 'TREAT', 'UPPER', 'VISIT', 'WORTH', 'ALIVE', 'BRICK', 'CHESS',
    'DODGE', 'EPOCH', 'FIBER', 'GLORY', 'HASTE', 'IDEAS', 'JOLLY', 'LEVER', 'MIXER',
    'NOVEL', 'OZONE', 'PITCH', 'REACT', 'SHARE', 'TIMER', 'VITAL', 'WOMAN', 'YOUNG',
    'AMBER', 'BRUSH', 'CYCLE', 'DANCE', 'ENACT', 'FRESH', 'GRAPE', 'HUMID', 'INFER',
    'JUMPS', 'KITES', 'LAYER', 'MARCH', 'OPINE', 'PRIZE', 'QUOTA', 'RIDER', 'SWEET',
    'TIGHT', 'USUAL', 'VOWEL', 'WIDER', 'AGILE', 'BLAST', 'CARGO', 'DRAFT', 'ELATE',
    'FLOCK', 'GRAIN', 'HARSH', 'INBOX', 'JAZZY', 'KNEAD', 'LOVER', 'METER', 'NINJA',
    'OASIS', 'PULSE', 'QUELL', 'RIVAL', 'SPARK', 'TRAIL', 'UPSET', 'VAPOR', 'WISER',
    'YODEL', 'ALGAE', 'CRISP', 'DEMON', 'EAGLE', 'FABLE', 'GUILD', 'IVORY', 'KARMA',
    'LEASH', 'MANGO', 'NOBLY', 'PENNY', 'ROVER', 'SLOPE', 'TRICK', 'VIRUS', 'WOVEN',
    'AZURE', 'BERRY', 'CIVIC', 'DROPS', 'ELFIN', 'FROZE', 'ICING', 'LAPSE', 'MIRTH',
    'NAVAL', 'OCTAL', 'PIPER', 'RUMOR', 'SWEAR', 'TANGO', 'ULTRA', 'VIXEN', 'WORRY',
    'ADORE', 'BLINK', 'CREEK', 'DIVER', 'ELOPE', 'FROTH', 'GRASS', 'HOUND', 'INLET',
    'LATCH', 'MASON', 'PRIOR', 'RUMBA', 'SHORE', 'TIDAL', 'WAXED', 'AMUSE', 'BRINE',
    'CLERK', 'DROOL', 'FLEET', 'GROOM', 'INCUR', 'LUNAR', 'MELON', 'OFTEN', 'PAPER',
    'SWEPT', 'THORN', 'VOWED', 'BLAZE', 'CROWD', 'FRAIL', 'GLOOM', 'JOKED', 'AMONG',
    'DEMON', 'FERRY', 'GRAIN', 'HASTE', 'ICING', 'JOKER', 'KNEEL', 'LAYER', 'MARCH',
    'NERVE', 'OPENS', 'PRIOR', 'QUILT', 'RANGE', 'SCENT', 'THINK', 'UNION', 'VAPOR',
    'WISER', 'YOUNG', 'ADAPT', 'BLINK', 'CARGO', 'DANCE', 'ELUDE', 'FRESH', 'GRASS',
    'HOUND', 'INLET', 'JUMPS', 'KITES', 'LEMON', 'MIGHT', 'NURSE', 'OZONE', 'PAPER',
    'QUAKE', 'RIDER', 'SHORE', 'TIGHT', 'URGED', 'VITAL', 'WOMAN', 'YODEL', 'AMBER',
    'BRINE', 'CLEAN', 'DROPS', 'ELATE', 'FLOCK', 'GLOOM', 'HUMID', 'INFER', 'JOLLY',
    'KNEAD', 'LATCH', 'MASON', 'NOVEL', 'OPINE', 'PRIZE', 'QUOTA', 'ROVER', 'SWEET',
    'TANGO', 'ULTRA', 'VIXEN', 'WORRY', 'AGILE', 'BLAZE', 'CIVIC', 'DRAFT', 'EAGER',
    'FIBER', 'GUILD', 'IVORY', 'KARMA', 'LEASH', 'MANGO', 'NOBLY', 'PENNY', 'QUELL',
    'RIVAL', 'SPARK', 'TRAIL', 'UPSET', 'VOWED', 'WOVEN', 'AZURE', 'BERRY', 'CLOVE',
    'DEFER', 'EPOCH', 'FABLE', 'GRIND', 'HUMOR', 'INDEX', 'JUDGE', 'LEARN', 'METER',
    'NINJA', 'OASIS', 'PITCH', 'REACT', 'SMILE', 'TREAT', 'USUAL', 'VOWEL', 'WIDER',
    'YACHT', 'ADORE', 'BLAST', 'CREEK', 'DIVER', 'ELFIN', 'FROTH', 'GRAPE', 'HASTE',
    'INBOX', 'JAZZY', 'LAPSE', 'MIRTH', 'NAVAL', 'OCTAL', 'PIPER', 'RUMOR', 'SLOPE',
    'TRICK', 'ULCER', 'VIRAL', 'WAXED', 'AMUSE', 'BRUSH', 'CYCLE', 'DODGE', 'ENACT',
    'FROZE', 'GRAIN', 'HONEY', 'INPUT', 'JUICE', 'KNOCK', 'LASER', 'METAL', 'NORTH',
    'OFFER', 'PAUSE', 'QUART', 'RATIO', 'SHARP', 'TOWER', 'USAGE', 'WHEEL', 'YEAST',
    'ZESTY', 'ALIVE', 'BASIC', 'CABLE', 'DELTA', 'FANCY', 'GLASS', 'HABIT', 'IMAGE',
    'LUNCH', 'MOTOR', 'NOBLE', 'ORDER', 'PEACE', 'ROUTE', 'SOLID', 'THEME', 'UNDER',
    'VALUE', 'WATCH', 'YIELD', 'ACORN', 'BLOOM', 'CROWN', 'DEPTH', 'ELITE', 'FLAME',
    'GHOST', 'HUMAN', 'INNER', 'JELLY', 'LEVEL', 'MONEY', 'OPERA', 'PEARL', 'QUEST',
    'RANGE', 'SHINE', 'TEACH', 'URBAN', 'VIVID', 'WATER', 'YOUTH', 'ANGEL', 'BLADE',
    'CRANE', 'DRIVE', 'EARTH', 'FAITH', 'GIANT', 'HEART', 'MAGIC', 'POWER', 'RIVER',
    'STONE', 'UNITY', 'VOICE', 'WORLD', 'ZEBRA', 'CLOVE', 'DEFER', 'AGREE', 'ALERT',
    'BLADE', 'CARRY', 'DEALT', 'FROGS', 'GRANT', 'HARDY', 'ISSUE', 'JELLY', 'KNIFE',
    'LEMON', 'MIGHT', 'NOBLE', 'OCEAN', 'PRIME', 'QUICK', 'ROUTE', 'SOLVE', 'TRUST',
    'UPLIT', 'VIVID', 'WATER', 'YOUNG', 'ANGRY', 'BRAVE', 'CLOUD', 'DRIVE', 'EARLY',
    'FAINT', 'GIANT', 'HEARD', 'MAGIC', 'LEARN', 'POWER', 'RIVAL', 'SMOKE', 'TRAIL',
    'UNITY', 'VOICE', 'WORLD', 'YEARN', 'ZEBRA', 'ACUTE', 'BLEND', 'CHAOS', 'DRINK',
    'ELDER', 'FANCY', 'GLASS', 'HABIT', 'IMAGE', 'JUICE', 'KNEEL', 'LUNCH', 'MOTOR',
    'NORTH', 'OFFER', 'PAUSE', 'QUILT', 'RATIO', 'SHARP', 'TOWER', 'USAGE', 'VIRAL',
    'WHEEL', 'YACHT', 'ADAPT', 'BLOOM', 'CLEAN', 'DREAM', 'FLOOD', 'GRIND', 'HUMOR',
    'INPUT', 'JUDGE', 'KNACK', 'LEASH', 'MANGO', 'NURSE', 'OPENS', 'PRIZE', 'QUAKE',
    'RIDER', 'SHINE', 'TREAT', 'UPPER', 'VISIT', 'WORTH', 'ALIVE', 'BRICK', 'CHESS',
    'DODGE', 'EPOCH', 'FIBER', 'GLORY', 'HASTE', 'IDEAL', 'JOLLY', 'LEVER', 'MIXER',
    'NOVEL', 'OZONE', 'PITCH', 'REACT', 'SHARE', 'TIMER', 'VITAL', 'WOMAN', 'AMBER',
    'BRUSH', 'CYCLE', 'DANCE', 'ENACT', 'FRESH', 'GRAPE', 'HUMID', 'INFER', 'JUMPS',
    'KITES', 'LAYER', 'MARCH', 'OPINE', 'QUOTA', 'RIDER', 'SWEET', 'TIGHT', 'USUAL',
    'VOWEL', 'WIDER', 'AGILE', 'BLAST', 'CARGO', 'DRAFT', 'ELATE', 'FLOCK', 'GRAIN',
    'HARSH', 'INBOX', 'JAZZY', 'KNEAD', 'LOVER', 'METER', 'NINJA', 'OASIS', 'PULSE',
    'QUELL', 'RIVAL', 'SPARK', 'TRAIL', 'UPSET', 'VAPOR', 'WISER', 'YODEL', 'ALGAE',
    'CRISP', 'DEMON', 'EAGLE', 'FABLE', 'GUILD', 'IVORY', 'KARMA', 'LEASH', 'MANGO',
    'NOBLY', 'PENNY', 'ROVER', 'SLOPE', 'TRICK', 'VIRUS', 'WOVEN', 'AZURE', 'BERRY',
    'CIVIC', 'DROPS', 'ELFIN', 'FROZE', 'ICING', 'LAPSE', 'MIRTH', 'NAVAL', 'OCTAL',
    'PIPER', 'RUMOR', 'SWEAR', 'TANGO', 'ULTRA', 'VIXEN', 'WORRY', 'ADORE', 'BLINK',
    'CREEK', 'DIVER', 'ELOPE', 'FROTH', 'GRASS', 'HOUND', 'INLET', 'LATCH', 'MASON',
    'PRIOR', 'RUMBA', 'SHORE', 'TIDAL', 'WAXED', 'AMUSE', 'BRINE', 'CLERK', 'DROOL',
    'FLEET', 'GROOM', 'INCUR', 'LUNAR', 'MELON', 'OFTEN', 'PAPER', 'SWEPT', 'THORN',
    'VOWED', 'BLAZE', 'CROWD', 'FRAIL', 'GLOOM', 'JOKED', 'AMONG', 'CLOVE', 'DEFER',
    'EPOCH', 'FABLE', 'GRIND', 'HONEY', 'INPUT', 'JUICE', 'KNOCK', 'LASER'
  ];

  // --- State ---------------------------------------------------------------
  // wrdState always has exactly the fields of the save, in the save's order.
  // wrdLastSynced is the save text this tab last wrote or adopted, so a write
  // from another tab can be told apart from our own.  wrdPointerFocus is the
  // element that last got the focus from a mouse click or a tap (null when
  // the focus came from the keyboard or the browser cannot tell).

  var wrdState = wrdFreshState(0);
  var wrdTimerId = null;
  var wrdLastSynced = null;
  var wrdPointerFocus = null;

  // --- Game rules (no DOM) -------------------------------------------------

  function wrdFreshState(wins) {
    return { solution: '', guesses: [], current: '', timer: 0, wins: wins, finished: false };
  }

  function wrdPickWord() {
    return wrdWords[Math.floor(Math.random() * wrdWords.length)];
  }

  // The colour of each letter of a guess: 'correct', 'present' or 'absent'.
  // Exact matches are marked first; then each letter of the solution that is
  // still unmatched can mark one misplaced copy in the guess, left to right,
  // so a repeated letter is never marked more often than the solution has it.
  function wrdScoreGuess(guess, solution) {
    var marks = [];
    var unmatched = {};
    var i;

    for (i = 0; i < WRD_WORD_LENGTH; i++) {
      if (guess.charAt(i) === solution.charAt(i)) {
        marks.push('correct');
      } else {
        marks.push('absent');
        unmatched[solution.charAt(i)] = (unmatched[solution.charAt(i)] || 0) + 1;
      }
    }

    for (i = 0; i < WRD_WORD_LENGTH; i++) {
      var letter = guess.charAt(i);

      if (marks[i] === 'absent' && unmatched[letter] > 0) {
        marks[i] = 'present';
        unmatched[letter] -= 1;
      }
    }

    return marks;
  }

  // 'won', 'lost', or null while the round is still open.
  function wrdOutcome(state) {
    var count = state.guesses.length;

    if (count > 0 && state.guesses[count - 1] === state.solution) {
      return 'won';
    }

    return count >= WRD_MAX_GUESSES ? 'lost' : null;
  }

  function wrdResultText(state) {
    var outcome = wrdOutcome(state);

    if (outcome === 'won') {
      return WRD_TEXT.won;
    }

    return outcome === 'lost' ? WRD_TEXT.lost + state.solution : '';
  }

  function wrdPad2(number) {
    return number < 10 ? '0' + number : String(number);
  }

  // Whole seconds as mm:ss; the minutes keep counting past 59 (60:00).
  function wrdFormatTime(seconds) {
    return wrdPad2(Math.floor(seconds / 60)) + ':' + wrdPad2(seconds % 60);
  }

  // --- Saved state ---------------------------------------------------------

  function wrdIsPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function wrdIsWord(value) {
    return typeof value === 'string' && WRD_WORD_RE.test(value);
  }

  function wrdIsCount(value) {
    return typeof value === 'number' && isFinite(value) && value >= 0 && Math.floor(value) === value;
  }

  function wrdParseJson(text) {
    if (typeof text !== 'string') {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  // A copy of a parsed save if it is a round this game could have written,
  // else null.  It is checked as a whole: the solution and every guess are
  // five capitals, at most six guesses, the round ends at the first correct
  // guess, the typed letters fit the row, the timer and the wins are whole
  // numbers >= 0, and `finished` matches the guesses (nothing typed after).
  function wrdNormalizeState(raw) {
    if (!wrdIsPlainObject(raw) || !wrdIsWord(raw.solution) || !Array.isArray(raw.guesses)) {
      return null;
    }

    if (raw.guesses.length > WRD_MAX_GUESSES || typeof raw.current !== 'string' || !WRD_PARTIAL_RE.test(raw.current)) {
      return null;
    }

    if (!wrdIsCount(raw.timer) || !wrdIsCount(raw.wins) || typeof raw.finished !== 'boolean') {
      return null;
    }

    for (var i = 0; i < raw.guesses.length; i++) {
      if (!wrdIsWord(raw.guesses[i]) || (raw.guesses[i] === raw.solution && i < raw.guesses.length - 1)) {
        return null;
      }
    }

    var state = {
      solution: raw.solution,
      guesses: raw.guesses.slice(),
      current: raw.current,
      timer: raw.timer,
      wins: raw.wins,
      finished: raw.finished
    };

    if (state.finished !== (wrdOutcome(state) !== null) || (state.finished && state.current !== '')) {
      return null;
    }

    return state;
  }

  // The win count of a damaged save, when that field alone is still usable.
  function wrdSavedWins(raw) {
    return wrdIsPlainObject(raw) && wrdIsCount(raw.wins) ? raw.wins : 0;
  }

  // The save text, in the field order every version has written.
  function wrdSerialize(state) {
    return JSON.stringify({
      solution: state.solution,
      guesses: state.guesses,
      current: state.current,
      timer: state.timer,
      wins: state.wins,
      finished: state.finished
    });
  }

  // --- Elements and rendering ----------------------------------------------
  // Elements are looked up when used, so the script works wherever the page
  // loads it (before or after the markup).

  function wrdEl(name) {
    return document.getElementById(WRD_IDS[name]);
  }

  function wrdShowToast(message) {
    wrdEl('toast').textContent = message;
  }

  function wrdUpdateStats() {
    wrdEl('wins').textContent = 'Wins: ' + wrdState.wins;
  }

  function wrdRenderTimer() {
    wrdEl('timer').textContent = wrdFormatTime(wrdState.timer);
  }

  // The result of a finished round ('You win!' or the revealed word); an open
  // round clears the message.
  function wrdRenderResult() {
    wrdShowToast(wrdResultText(wrdState));
  }

  function wrdCreateCell(letter, mark) {
    var cell = document.createElement('div');

    cell.className = 'wrd-cell';
    cell.textContent = letter;

    if (mark) {
      cell.classList.add('wrd-' + mark);
    }

    return cell;
  }

  // Six rows of five cells: the coloured guesses, then the letters being typed.
  function wrdRenderBoard() {
    var board = wrdEl('board');

    board.innerHTML = '';

    for (var row = 0; row < WRD_MAX_GUESSES; row++) {
      var guess = wrdState.guesses[row] || '';
      var marks = guess ? wrdScoreGuess(guess, wrdState.solution) : [];
      var letters = guess;

      if (row === wrdState.guesses.length && !wrdState.finished) {
        letters = wrdState.current;
      }

      for (var col = 0; col < WRD_WORD_LENGTH; col++) {
        board.appendChild(wrdCreateCell(letters.charAt(col), marks[col]));
      }
    }
  }

  // Everything that shows the round: board, wins, clock and result message.
  function wrdRenderRound() {
    wrdRenderBoard();
    wrdUpdateStats();
    wrdRenderTimer();
    wrdRenderResult();
  }

  // A mouse click or a tap leaves the focus on the button, and the browser
  // would click it again on the next Space or Enter (typing a letter twice,
  // or throwing the round away).  Keyboard activation (detail 0) keeps it.
  function wrdReleasePointerFocus(button, event) {
    if (event.detail > 0) {
      button.blur();
    }
  }

  function wrdCreateKey(label, key, className) {
    var button = document.createElement('button');

    button.className = className;
    button.textContent = label;
    button.addEventListener('click', function (event) {
      wrdReleasePointerFocus(button, event);
      wrdHandleKey(key);
    });

    return button;
  }

  function wrdCreateKeyRow() {
    var row = document.createElement('div');

    row.className = 'wrd-key-row';

    return row;
  }

  // Three QWERTY rows and a row with Enter and Backspace; drawing again
  // replaces the keys.
  function wrdRenderKeyboard() {
    var keyboard = wrdEl('keyboard');

    keyboard.innerHTML = '';

    WRD_KEY_ROWS.forEach(function (letters) {
      var row = wrdCreateKeyRow();

      letters.split('').forEach(function (letter) {
        row.appendChild(wrdCreateKey(letter, letter, 'wrd-key'));
      });

      keyboard.appendChild(row);
    });

    var actions = wrdCreateKeyRow();

    actions.appendChild(wrdCreateKey(WRD_ENTER, WRD_ENTER, 'wrd-key wrd-key-wide'));
    actions.appendChild(wrdCreateKey(WRD_BACKSPACE_LABEL, WRD_BACKSPACE, 'wrd-key wrd-key-wide'));

    keyboard.appendChild(actions);
  }

  // --- Storage and other tabs ----------------------------------------------
  // Storage can be blocked or full; the game then plays on without saving.

  function wrdStorageGet() {
    try {
      return localStorage.getItem(WRD_STORAGE_KEY);
    } catch (error) {
      return null;
    }
  }

  function wrdStorageSet(text) {
    try {
      localStorage.setItem(WRD_STORAGE_KEY, text);
      return true;
    } catch (error) {
      return false;
    }
  }

  function wrdSave() {
    var text = wrdSerialize(wrdState);

    if (wrdStorageSet(text)) {
      wrdLastSynced = text;
    }
  }

  // Restores the saved round.  Returns true when there was one to resume; a
  // missing or damaged save leaves a state without a solution (keeping a
  // usable win count) and never throws.
  function wrdLoad() {
    var text = wrdStorageGet();
    var raw = wrdParseJson(text);
    var state = wrdNormalizeState(raw);

    wrdLastSynced = text;
    wrdState = state || wrdFreshState(wrdSavedWins(raw));

    return state !== null;
  }

  // Takes over a round another tab of the game saved, so all tabs play one
  // round and none overwrites another's progress.  The larger win count is
  // kept (and written back when this tab's was larger).  Text this tab
  // already has, or a damaged save, changes nothing.
  function wrdAdoptSaved(text) {
    if (text === null || text === wrdLastSynced) {
      return;
    }

    var next = wrdNormalizeState(wrdParseJson(text));

    if (!next) {
      return;
    }

    var newRound = next.solution !== wrdState.solution || next.guesses.length < wrdState.guesses.length;
    var keepWins = next.wins < wrdState.wins;

    if (keepWins) {
      next.wins = wrdState.wins;
    }

    wrdLastSynced = text;
    wrdState = next;

    wrdRenderBoard();
    wrdUpdateStats();
    wrdRenderTimer();

    if (wrdState.finished) {
      wrdRenderResult();
    } else if (newRound) {
      wrdShowToast(WRD_TEXT.newGame);
    }

    if (keepWins) {
      wrdSave();
    }
  }

  function wrdOnStorage(event) {
    if (event.key === WRD_STORAGE_KEY) {
      wrdAdoptSaved(event.newValue);
    }
  }

  // The clock is saved when the page is hidden (tab switch, close, reload),
  // not on every tick, so a tab in the background never writes over a newer
  // round.  A page shown again picks up what other tabs saved meanwhile.
  function wrdOnVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      wrdSave();
    } else {
      wrdAdoptSaved(wrdStorageGet());
    }
  }

  // --- Timer ---------------------------------------------------------------

  function wrdTick() {
    if (wrdState.finished) {
      return;
    }

    wrdState.timer += 1;
    wrdRenderTimer();
  }

  function wrdStopTimer() {
    if (wrdTimerId !== null) {
      clearInterval(wrdTimerId);
      wrdTimerId = null;
    }
  }

  // One interval at most: starting again replaces the running one.
  function wrdStartTimer() {
    wrdStopTimer();
    wrdTimerId = setInterval(wrdTick, WRD_TICK_MS);
  }

  // --- Game flow -----------------------------------------------------------

  function wrdNewGame() {
    wrdState = wrdFreshState(wrdState.wins);
    wrdState.solution = wrdPickWord();

    // A running clock restarts, so the new round's first second is a full one
    if (wrdTimerId !== null) {
      wrdStartTimer();
    }

    wrdRenderBoard();
    wrdUpdateStats();
    wrdRenderTimer();
    wrdSave();

    wrdShowToast(WRD_TEXT.newGame);
  }

  function wrdSubmitGuess() {
    if (wrdState.finished) {
      return;
    }

    if (wrdState.current.length !== WRD_WORD_LENGTH) {
      wrdShowToast(WRD_TEXT.tooShort);
      return;
    }

    wrdState.guesses.push(wrdState.current);
    wrdState.current = '';

    var outcome = wrdOutcome(wrdState);

    if (outcome) {
      wrdState.finished = true;

      if (outcome === 'won') {
        wrdState.wins += 1;
      }

      wrdRenderResult();
    }

    wrdUpdateStats();
    wrdRenderBoard();
    wrdSave();
  }

  // One key of the round: 'A'-'Z', 'ENTER' or 'BACKSPACE' (physical and
  // on-screen keys alike).  Nothing is drawn or saved when nothing changes.
  function wrdHandleKey(key) {
    if (wrdState.finished) {
      return;
    }

    if (key === WRD_ENTER) {
      wrdSubmitGuess();
      return;
    }

    var current = wrdState.current;

    if (key === WRD_BACKSPACE) {
      current = current.slice(0, -1);
    } else if (WRD_LETTER_RE.test(key) && current.length < WRD_WORD_LENGTH) {
      current += key;
    }

    if (current === wrdState.current) {
      return;
    }

    wrdState.current = current;
    wrdRenderBoard();
    wrdSave();
  }

  function wrdOnToolbarClick(event) {
    wrdReleasePointerFocus(this, event);
    wrdNewGame();
  }

  // --- Input ---------------------------------------------------------------

  // Editable fields on the host page (the WordPress search or comment box).
  // The game has none of its own.
  function wrdIsEditable(target) {
    if (!target) {
      return false;
    }

    var tag = String(target.tagName || '').toUpperCase();

    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
  }

  // Whether the element is part of the game (ids and classes carry wrd-).
  function wrdInGame(target) {
    for (var node = target; node; node = node.parentNode) {
      if (/^wrd-/.test(String(node.id || '')) || /(^|\s)wrd-/.test(String(node.className || ''))) {
        return true;
      }
    }

    return false;
  }

  // Whether the target is a control of the host page that acts on Enter
  // itself: a link, a button, a <summary> or an ARIA button or link outside
  // the game.  Enter on it is left to it when the player reached it with the
  // keyboard.  Enter anywhere else (the page, a focusable container, the
  // game's own buttons) is the game's.
  function wrdIsHostControl(target) {
    if (!target || typeof target.tagName !== 'string' || typeof target.getAttribute !== 'function') {
      return false;
    }

    var tag = target.tagName.toUpperCase();
    var acts = tag === 'BUTTON' || tag === 'SUMMARY' ||
      ((tag === 'A' || tag === 'AREA') && target.getAttribute('href') !== null) ||
      /^\s*(button|link)(\s|$)/i.test(String(target.getAttribute('role') || ''));

    return acts && !wrdInGame(target);
  }

  // Whether the browser draws a focus ring on the element: it does when the
  // focus came from the keyboard (Tab) and not from a mouse click or a tap.
  // A browser without :focus-visible cannot tell, which counts as keyboard.
  function wrdFocusVisible(target) {
    try {
      return typeof target.matches !== 'function' || target.matches(':focus-visible') === true;
    } catch (error) {
      return true;
    }
  }

  // Remembers how the focus arrived.  It is read here, as the focus moves:
  // Chromium turns :focus-visible on for the focused element as soon as any
  // key is pressed, so a keydown can no longer tell.
  function wrdOnFocusIn(event) {
    wrdPointerFocus = wrdFocusVisible(event.target) ? null : event.target;
  }

  // The name wrdHandleKey uses for a KeyboardEvent key, or '' for a key the
  // game does not play.
  function wrdKeyName(key) {
    var name = key.toUpperCase();

    return WRD_LETTER_RE.test(name) || name === WRD_ENTER || name === WRD_BACKSPACE ? name : '';
  }

  // Physical keyboard.  Shortcuts (Ctrl/Cmd/Alt + key) stay with the browser
  // and typing in an editable field stays with that field.  A key the game
  // plays has its default action cancelled, so Enter never also clicks a
  // focused game button; a held Enter (auto-repeat) plays nothing.  A
  // finished round plays no keys, so Enter still works a focused New Game.
  // Enter on a link or button of the host page that the player reached with
  // the keyboard is left to it.  One clicked with the mouse (Chrome and
  // Firefox leave the focus on it) gets no Enter: the game takes the focus
  // from it and submits the guess.  A letter or Backspace takes the focus
  // from any host control, so the next Enter submits the guess.
  function wrdOnKeyDown(event) {
    // Chrome autofill fires keydown events that carry no key
    if (typeof event.key !== 'string') {
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey || wrdIsEditable(event.target)) {
      return;
    }

    var key = wrdKeyName(event.key);
    var hostControl = wrdIsHostControl(event.target);
    var hostKeepsEnter = hostControl && event.target !== wrdPointerFocus;

    if (!key || (key === WRD_ENTER && hostKeepsEnter)) {
      return;
    }

    if (key === WRD_ENTER && event.repeat) {
      event.preventDefault();
      return;
    }

    if (wrdState.finished) {
      return;
    }

    event.preventDefault();

    if (hostControl && typeof event.target.blur === 'function') {
      event.target.blur();
    }

    wrdHandleKey(key);
  }

  // --- Init and start-up ---------------------------------------------------
  // Safe to call again: the listeners are the same functions (added once),
  // the keyboard is redrawn and the clock replaced.

  function init() {
    document.addEventListener('keydown', wrdOnKeyDown);
    document.addEventListener('focusin', wrdOnFocusIn, true);
    document.addEventListener('visibilitychange', wrdOnVisibilityChange);
    window.addEventListener('storage', wrdOnStorage);

    wrdEl('newGame').addEventListener('click', wrdOnToolbarClick);
    wrdEl('restart').addEventListener('click', wrdOnToolbarClick);

    if (wrdLoad()) {
      wrdRenderRound();
    } else {
      wrdNewGame();
    }

    wrdRenderKeyboard();
    wrdStartTimer();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else if (typeof module === 'undefined' || !module.exports) {
    init();
  }

  /* Node test export (no effect in browsers) */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      wrdWords: wrdWords,
      wrdPickWord: wrdPickWord,
      wrdScoreGuess: wrdScoreGuess,
      wrdOutcome: wrdOutcome,
      wrdFormatTime: wrdFormatTime,
      wrdNormalizeState: wrdNormalizeState,
      wrdSave: wrdSave,
      wrdLoad: wrdLoad,
      wrdShowToast: wrdShowToast,
      wrdUpdateStats: wrdUpdateStats,
      wrdRenderBoard: wrdRenderBoard,
      wrdRenderTimer: wrdRenderTimer,
      wrdRenderResult: wrdRenderResult,
      wrdNewGame: wrdNewGame,
      wrdSubmitGuess: wrdSubmitGuess,
      wrdHandleKey: wrdHandleKey,
      wrdRenderKeyboard: wrdRenderKeyboard,
      wrdStartTimer: wrdStartTimer,
      wrdStopTimer: wrdStopTimer,
      wrdIsEditable: wrdIsEditable,
      wrdOnKeyDown: wrdOnKeyDown,
      init: init,
      // wrdLoad(), wrdNewGame() and other tabs replace the state object, so
      // read it through a getter
      get wrdState() { return wrdState; }
    };
  }
})();
