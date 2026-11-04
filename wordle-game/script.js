// Cyberpunk Wordle — script.js
// Prefix: wrd-
// Dependencies: none.
(function () {
  'use strict';

var wrdWords = [
"CRANE","SLATE","BRINE","STONE","SHARE","GRACE","PLANT","TRACK","SWORD",
"APPLE","BRAVE","CLOUD","DRIVE","EARTH","FAITH","GIANT","HEART","MAGIC",
"LEMON","POWER","RIVER","SMILE","TRUST","UNITY","VOICE","WORLD","YEAST",
"ZEBRA","ALERT","BLEND","CHAIR","DREAM","ENJOY","FROST","HONEY","INNER",
"JELLY","LASER","METAL","NIGHT","OPERA","PEARL","QUEST","RANGE","SHINE",
"TEACH","URBAN","VIVID","WATER","YOUTH","ANGEL","BLADE","CROWN","DEPTH",
"ELITE","FLAME","GHOST","HUMAN","INDEX","LEVEL","MONEY","NOBLE","ORDER",
"PEACE","ROUTE","SOLID","THEME","UNDER","VALUE","WATCH","YIELD","ACORN",
"BASIC","CABLE","DELTA","EAGER","FANCY","GLASS","HABIT","IMAGE","JUICE",
"LUNCH","MOTOR","NORTH","OFFER","PAUSE","QUILT","RATIO","SHARP","TOWER",
"USAGE","VIRAL","WHEEL","YACHT","ADAPT","BLOOM","CLEAN","DRINK","ELDER",
"FLOOD","GRIND","HUMOR","INPUT","JUDGE","LEARN","MIGHT","NURSE","PRIME",
"QUAKE","ROCKY","TREAT","UPPER","VISIT","WORTH","ALIVE","BRICK","CHESS",
"DODGE","EPOCH","FIBER","GLORY","HASTE","IDEAS","JOLLY","LEVER","MIXER",
"NOVEL","OZONE","PITCH","REACT","SHARE","TIMER","VITAL","WOMAN","YOUNG",
"AMBER","BRUSH","CYCLE","DANCE","ENACT","FRESH","GRAPE","HUMID","INFER",
"JUMPS","KITES","LAYER","MARCH","OPINE","PRIZE","QUOTA","RIDER","SWEET",
"TIGHT","USUAL","VOWEL","WIDER","AGILE","BLAST","CARGO","DRAFT","ELATE",
"FLOCK","GRAIN","HARSH","INBOX","JAZZY","KNEAD","LOVER","METER","NINJA",
"OASIS","PULSE","QUELL","RIVAL","SPARK","TRAIL","UPSET","VAPOR","WISER",
"YODEL","ALGAE","CRISP","DEMON","EAGLE","FABLE","GUILD","IVORY","KARMA",
"LEASH","MANGO","NOBLY","PENNY","ROVER","SLOPE","TRICK","VIRUS","WOVEN",
"AZURE","BERRY","CIVIC","DROPS","ELFIN","FROZE","ICING","LAPSE","MIRTH",
"NAVAL","OCTAL","PIPER","RUMOR","SWEAR","TANGO","ULTRA","VIXEN","WORRY",
"ADORE","BLINK","CREEK","DIVER","ELOPE","FROTH","GRASS","HOUND","INLET",
"LATCH","MASON","PRIOR","RUMBA","SHORE","TIDAL","WAXED","AMUSE","BRINE",
"CLERK","DROOL","FLEET","GROOM","INCUR","LUNAR","MELON","OFTEN","PAPER",
"SWEPT","THORN","VOWED","BLAZE","CROWD","FRAIL","GLOOM","JOKED","AMONG",
"DEMON","FERRY","GRAIN","HASTE","ICING","JOKER","KNEEL","LAYER","MARCH",
"NERVE","OPENS","PRIOR","QUILT","RANGE","SCENT","THINK","UNION","VAPOR",
"WISER","YOUNG","ADAPT","BLINK","CARGO","DANCE","ELUDE","FRESH","GRASS",
"HOUND","INLET","JUMPS","KITES","LEMON","MIGHT","NURSE","OZONE","PAPER",
"QUAKE","RIDER","SHORE","TIGHT","URGED","VITAL","WOMAN","YODEL","AMBER",
"BRINE","CLEAN","DROPS","ELATE","FLOCK","GLOOM","HUMID","INFER","JOLLY",
"KNEAD","LATCH","MASON","NOVEL","OPINE","PRIZE","QUOTA","ROVER","SWEET",
"TANGO","ULTRA","VIXEN","WORRY","AGILE","BLAZE","CIVIC","DRAFT","EAGER",
"FIBER","GUILD","IVORY","KARMA","LEASH","MANGO","NOBLY","PENNY","QUELL",
"RIVAL","SPARK","TRAIL","UPSET","VOWED","WOVEN","AZURE","BERRY","CLOVE",
"DEFER","EPOCH","FABLE","GRIND","HUMOR","INDEX","JUDGE","LEARN","METER",
"NINJA","OASIS","PITCH","REACT","SMILE","TREAT","USUAL","VOWEL","WIDER",
"YACHT","ADORE","BLAST","CREEK","DIVER","ELFIN","FROTH","GRAPE","HASTE",
"INBOX","JAZZY","KRAUT","LAPSE","MIRTH","NAVAL","OCTAL","PIPER","RUMOR",
"SLOPE","TRICK","ULCER","VIRAL","WAXED","AMUSE","BRUSH","CYCLE","DODGE",
"ENACT","FROZE","GRAIN","HONEY","INPUT","JUICE","KNOCK","LASER","METAL",
"NORTH","OFFER","PAUSE","QUART","RATIO","SHARP","TOWER","USAGE","WHEEL",
"YEAST","ZESTY","ALIVE","BASIC","CABLE","DELTA","FANCY","GLASS","HABIT",
"IMAGE","LUNCH","MOTOR","NOBLE","ORDER","PEACE","ROUTE","SOLID","THEME",
"UNDER","VALUE","WATCH","YIELD","ACORN","BLOOM","CROWN","DEPTH","ELITE",
"FLAME","GHOST","HUMAN","INNER","JELLY","LEVEL","MONEY","OPERA","PEARL",
"QUEST","RANGE","SHINE","TEACH","URBAN","VIVID","WATER","YOUTH","ANGEL",
"BLADE","CRANE","DRIVE","EARTH","FAITH","GIANT","HEART","MAGIC","POWER",
"RIVER","STONE","UNITY","VOICE","WORLD","ZEBRA","CLOVE","DEFER","AGREE",
"ALERT","BLADE","CARRY","DEALT","FROGS","GRANT","HARDY","ISSUE","JELLY",
"KNIFE","LEMON","MIGHT","NOBLE","OCEAN","PRIME","QUICK","ROUTE","SOLVE",
"TRUST","UPLIT","VIVID","WATER","YOUNG","ANGRY","BRAVE","CLOUD","DRIVE",
"EARLY","FAINT","GIANT","HEARD","MAGIC","LEARN","POWER","RIVAL","SMOKE",
"TRAIL","UNITY","VOICE","WORLD","YEARN","ZEBRA","ACUTE","BLEND","CHAOS",
"DRINK","ELDER","FANCY","GLASS","HABIT","IMAGE","JUICE","KNEEL","LUNCH",
"MOTOR","NORTH","OFFER","PAUSE","QUILT","RATIO","SHARP","TOWER","USAGE",
"VIRAL","WHEEL","YACHT","ADAPT","BLOOM","CLEAN","DREAM","FLOOD","GRIND",
"HUMOR","INPUT","JUDGE","KNACK","LEASH","MANGO","NURSE","OPENS","PRIZE",
"QUAKE","RIDER","SHINE","TREAT","UPPER","VISIT","WORTH","ALIVE","BRICK",
"CHESS","DODGE","EPOCH","FIBER","GLORY","HASTE","IDEAL","JOLLY","LEVER",
"MIXER","NOVEL","OZONE","PITCH","REACT","SHARE","TIMER","VITAL","WOMAN",
"AMBER","BRUSH","CYCLE","DANCE","ENACT","FRESH","GRAPE","HUMID","INFER",
"JUMPS","KITES","LAYER","MARCH","OPINE","QUOTA","RIDER","SWEET","TIGHT",
"USUAL","VOWEL","WIDER","AGILE","BLAST","CARGO","DRAFT","ELATE","FLOCK",
"GRAIN","HARSH","INBOX","JAZZY","KNEAD","LOVER","METER","NINJA","OASIS",
"PULSE","QUELL","RIVAL","SPARK","TRAIL","UPSET","VAPOR","WISER","YODEL",
"ALGAE","CRISP","DEMON","EAGLE","FABLE","GUILD","IVORY","KARMA","LEASH",
"MANGO","NOBLY","PENNY","ROVER","SLOPE","TRICK","VIRUS","WOVEN","AZURE",
"BERRY","CIVIC","DROPS","ELFIN","FROZE","ICING","LAPSE","MIRTH","NAVAL",
"OCTAL","PIPER","RUMOR","SWEAR","TANGO","ULTRA","VIXEN","WORRY","ADORE",
"BLINK","CREEK","DIVER","ELOPE","FROTH","GRASS","HOUND","INLET","LATCH",
"MASON","PRIOR","RUMBA","SHORE","TIDAL","WAXED","AMUSE","BRINE","CLERK",
"DROOL","FLEET","GROOM","INCUR","LUNAR","MELON","OFTEN","PAPER","SWEPT",
"THORN","VOWED","BLAZE","CROWD","FRAIL","GLOOM","JOKED","AMONG","CLOVE",
"DEFER","EPOCH","FABLE","GRIND","HONEY","INPUT","JUICE","KNOCK","LASER"
];




  var wrdState = {
    solution: '',
    guesses: [],
    current: '',
    timer: 0,
    wins: 0,
    finished: false
  };

  var wrdBoard = document.getElementById('wrd-board');
  var wrdKeyboard = document.getElementById('wrd-keyboard');
  var wrdToast = document.getElementById('wrd-toast');
  var wrdTimer = document.getElementById('wrd-timer');
  var wrdWins = document.getElementById('wrd-games-won');

  function wrdPickWord() {
    return wrdWords[Math.floor(Math.random() * wrdWords.length)];
  }

  function wrdSave() {
    localStorage.setItem('wrd-state', JSON.stringify(wrdState));
  }

  function wrdLoad() {
    var saved = localStorage.getItem('wrd-state');

    if (saved) {
      wrdState = JSON.parse(saved);
    }
  }

  function wrdShowToast(message) {
    wrdToast.textContent = message;
  }

  function wrdUpdateStats() {
    wrdWins.textContent = 'Wins: ' + wrdState.wins;
  }

  function wrdRenderBoard() {
    wrdBoard.innerHTML = '';

    for (var row = 0; row < 6; row++) {
      var guess = wrdState.guesses[row] || '';
      var displayWord = guess;

      if (row === wrdState.guesses.length && !wrdState.finished) {
        displayWord = wrdState.current;
      }

      for (var col = 0; col < 5; col++) {
        var cell = document.createElement('div');
        cell.className = 'wrd-cell';

        var letter = displayWord[col] || '';
        cell.textContent = letter;

        if (guess[col]) {
          if (wrdState.solution[col] === guess[col]) {
            cell.classList.add('wrd-correct');
          } else if (wrdState.solution.indexOf(guess[col]) !== -1) {
            cell.classList.add('wrd-present');
          } else {
            cell.classList.add('wrd-absent');
          }
        }

        wrdBoard.appendChild(cell);
      }
    }
  }

  function wrdNewGame() {
    wrdState.solution = wrdPickWord();
    wrdState.guesses = [];
    wrdState.current = '';
    wrdState.timer = 0;
    wrdState.finished = false;

    wrdRenderBoard();
    wrdUpdateStats();
    wrdSave();

    wrdShowToast('New game started');
  }

  function wrdSubmitGuess() {
    if (wrdState.finished) {
      return;
    }

    if (wrdState.current.length !== 5) {
      wrdShowToast('Enter a 5-letter word');
      return;
    }

    var guess = wrdState.current;

    wrdState.guesses.push(guess);
    wrdState.current = '';

    if (guess === wrdState.solution) {
      wrdState.finished = true;
      wrdState.wins += 1;
      wrdShowToast('You win!');
    } else if (wrdState.guesses.length >= 6) {
      wrdState.finished = true;
      wrdShowToast('Game over! Word: ' + wrdState.solution);
    }

    wrdUpdateStats();
    wrdRenderBoard();
    wrdSave();
  }

  function wrdHandleKey(key) {
    if (wrdState.finished) {
      return;
    }

    if (/^[A-Z]$/.test(key)) {
      if (wrdState.current.length < 5) {
        wrdState.current += key;
      }
    }

    if (key === 'BACKSPACE') {
      wrdState.current = wrdState.current.slice(0, -1);
    }

    if (key === 'ENTER') {
      wrdSubmitGuess();
      return;
    }

    wrdRenderBoard();
    wrdSave();
  }

  function wrdRenderKeyboard() {
    var rows = [
      'QWERTYUIOP',
      'ASDFGHJKL',
      'ZXCVBNM'
    ];

    wrdKeyboard.innerHTML = '';

    rows.forEach(function (rowLetters) {
      var row = document.createElement('div');
      row.className = 'wrd-key-row';

      rowLetters.split('').forEach(function (letter) {
        var key = document.createElement('button');
        key.className = 'wrd-key';
        key.textContent = letter;

        key.addEventListener('click', function () {
          wrdHandleKey(letter);
        });

        row.appendChild(key);
      });

      wrdKeyboard.appendChild(row);
    });

    var actions = document.createElement('div');
    actions.className = 'wrd-key-row';

    var enterBtn = document.createElement('button');
    enterBtn.className = 'wrd-key wrd-key-wide';
    enterBtn.textContent = 'ENTER';
    enterBtn.addEventListener('click', function () {
      wrdHandleKey('ENTER');
    });

    var backBtn = document.createElement('button');
    backBtn.className = 'wrd-key wrd-key-wide';
    backBtn.textContent = '⌫';
    backBtn.addEventListener('click', function () {
      wrdHandleKey('BACKSPACE');
    });

    actions.appendChild(enterBtn);
    actions.appendChild(backBtn);

    wrdKeyboard.appendChild(actions);
  }

  function wrdStartTimer() {
    setInterval(function () {
      if (!wrdState.finished) {
        wrdState.timer += 1;

        var mins = String(Math.floor(wrdState.timer / 60)).padStart(2, '0');
        var secs = String(wrdState.timer % 60).padStart(2, '0');

        wrdTimer.textContent = mins + ':' + secs;

        wrdSave();
      }
    }, 1000);
  }

  // Editable fields on the host page (the WordPress search or comment box).
  // The game has none of its own.
  function wrdIsEditable(target) {
    if (!target) {
      return false;
    }

    var tag = String(target.tagName || '').toUpperCase();

    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
  }

  // Physical keyboard.  Shortcuts (Ctrl/Cmd/Alt + key) stay with the browser
  // and typing in an editable field stays with that field.  A key the game
  // plays has its default action cancelled: otherwise Enter would also click
  // the on-screen key or New Game button that kept the focus after a tap.
  function wrdOnKeyDown(event) {
    // Chrome autofill fires keydown events that carry no key
    if (typeof event.key !== 'string') {
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey || wrdIsEditable(event.target)) {
      return;
    }

    var key = event.key.toUpperCase();

    if (!/^[A-Z]$/.test(key) && key !== 'ENTER' && key !== 'BACKSPACE') {
      return;
    }

    // A finished round plays no keys, so Enter still works a focused New Game button
    if (wrdState.finished) {
      return;
    }

    event.preventDefault();
    wrdHandleKey(key);
  }

  function init() {
    document.addEventListener('keydown', wrdOnKeyDown);

    document.getElementById('wrd-new-game').addEventListener('click', wrdNewGame);
    document.getElementById('wrd-restart-game').addEventListener('click', wrdNewGame);

    wrdLoad();

    if (!wrdState.solution) {
      wrdNewGame();
    } else {
      wrdRenderBoard();
      wrdUpdateStats();
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
      wrdSave: wrdSave,
      wrdLoad: wrdLoad,
      wrdShowToast: wrdShowToast,
      wrdUpdateStats: wrdUpdateStats,
      wrdRenderBoard: wrdRenderBoard,
      wrdNewGame: wrdNewGame,
      wrdSubmitGuess: wrdSubmitGuess,
      wrdHandleKey: wrdHandleKey,
      wrdRenderKeyboard: wrdRenderKeyboard,
      wrdStartTimer: wrdStartTimer,
      wrdIsEditable: wrdIsEditable,
      wrdOnKeyDown: wrdOnKeyDown,
      init: init,
      // wrdLoad() replaces the state object, so read it through a getter
      get wrdState() { return wrdState; }
    };
  }
})();
