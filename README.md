# vahac-games

A collection of standalone browser games by Vahac. Each game is implemented with plain HTML, CSS, and JavaScript, so it can run locally without a backend. The Games section on vahac.com is currently private, so the page below opens only for a logged-in site editor until the section goes public.

Documentation status:
- Last updated: 2026-11-04 (refactor of all games and full test coverage)
- Scope synchronized with current repository structure

## Repository Structure

Games are grouped by genre, the same groups the index page (`index.html`) uses.

### Puzzle

- `2048-game/` - the 2048 sliding-tile puzzle on a 4x4 board, played with arrow keys or swipes, with undo of up to 10 moves, a best score and auto save to localStorage.
- `minesweeper/` - neon Minesweeper with Easy (9x9, 10 mines), Medium (14x14, 35) and Hard (18x18, 65) boards, a safe first click, right-click flags, flood reveal, a timer, the best time per difficulty and auto save to localStorage.
- `sudoku/` - classic 9x9 Sudoku with a freshly generated puzzle every game, hints, restart and auto save to localStorage.

### Word

- `wordle-game/` - Cyberpunk Wordle: guess a hidden five-letter word in six tries, with tiles coloured green, amber or grey, a physical or on-screen keyboard, a round timer, a win counter and auto save to localStorage.

### Arcade

- `snake-game/` - Snake on a 30x30 canvas grid: eat energy nodes for 10 points each, avoid the walls and your own tail, pick one of four speeds, and keep the saved game after a reload.

### Reflex and Typing

- `reaction-time/` - reaction time test: wait for the neon signal, then click, tap or press Space; four difficulty delay windows, false-start detection, current/best/average times and a summary after 10 rounds, saved in localStorage.
- `typing-speed-test/` - 60-second typing test on a random Easy, Medium or Hard sentence, with per-character highlighting, live WPM (correct characters / 5 per minute) and accuracy, and the best WPM of finished rounds and the difficulty saved in localStorage.

### Other files

- `index.html` - index page that lists every game by genre, with search.
- `css-template.md` - shared CSS/style guidance for game pages and the namespace prefix registry.
- `CHANGELOG.md` - what changed in each game and in the tests, newest first.

## Game Overview

### 1) 2048 Game

Path:
- `2048-game/index.html`

Features:
- Arrow keys on desktop or swipes on phones (a `touch-action: none` board with a 40 px swipe threshold); equal tiles merge once per move and the merged value is added to the score.
- Undo of up to 10 moves, plus New Game and Restart buttons, a best score, and "You reached 2048!" and Game Over messages.
- Saves the board and score (`tf8-2048-game`) and the best score (`tf8-2048-best-score`) to localStorage after every move and picks up where you left off after a reload.

### 2) Cyberpunk Wordle

Path:
- `wordle-game/index.html`

Features:
- Six tries at a random five-letter word from a built-in list; each letter of a guess is marked correct (green), present (amber) or absent (grey), and the round ends in a win or reveals the word.
- Type on the physical keyboard or tap the on-screen QWERTY keyboard with Enter and Backspace.
- A round timer and a win counter; the current round, the timer and the wins are saved in localStorage under `wrd-state` and restored after a reload.

### 3) Minesweeper Game

Path:
- `minesweeper/index.html`

Features:
- Three preset boards: Easy (9x9, 10 mines), Medium (14x14, 35) and Hard (18x18, 65); the mines are laid after the first click and never under the clicked cell.
- Right-click flags with a live mine counter; an empty cell opens outward until it reaches numbered cells; a timer runs while you play.
- The game, its timer and its result are saved in localStorage (`msp-save-state`) on every move and every second, so a reload brings back a game in progress with its clock running or a finished game as it ended; the best time is kept per difficulty (`msp-best-easy`, `msp-best-medium`, `msp-best-hard`).

### 4) Reaction Time Test

Path:
- `reaction-time/index.html`

Features:
- A random signal delay per difficulty (Easy 2–4.5 s, Normal 1.5–3.5 s, Hard 1–2.5 s, Extreme 0.6–1.6 s); clicking before the signal is a false start and is not counted.
- The reaction time comes from `performance.now()`, rounded to ms; it shows the current, best and average time, the attempts and a session timer, and a "Session Complete" summary after 10 successful rounds. The session then stays finished, also after a reload, until Play Again, New Game or Restart; Start or Enter show the summary again.
- Mouse (the press counts, not the release), touch and keyboard: Enter starts a round, also from the difficulty select, and Space reacts. Keys typed into other page fields, buttons or links are left alone. The difficulty, the stats and the session time are saved in localStorage under `rxt-reaction-state`. The session timer resumes after a reload, and an idle second tab never overwrites a newer save.

### 5) Snake Game

Path:
- `snake-game/index.html`

Features:
- Arrow keys or WASD, P to pause, Enter for a new game, plus on-screen arrow buttons on phones and touch screens; WASD and P also work with Caps Lock and on non-Latin keyboard layouts. The game takes keys only while the focus is on the page, the game or the area around it, so the host page's links, buttons and fields keep theirs. Each energy node scores 10 points, the walls and your own tail end the game, and 150 segments wins it.
- Four speeds (Easy 160 ms, Normal 120 ms, Hard 85 ms, Insane 60 ms per tick), a timer of the time the snake moves (pauses excluded) and a best score.
- The whole game (snake, food, score, best score, timer, speed) is saved in localStorage under `snp-snake-state` and comes back after a reload: a running or paused game waits for the first key, and a finished game starts over with the best score and speed kept. With storage blocked the game still plays, just without saving.

### 6) Sudoku Game

Path:
- `sudoku/index.html`

Features:
- Every New Game is a fresh puzzle: a randomised backtracking solver fills the grid, then 45 cells are blanked, each only while the puzzle keeps exactly one solution.
- Hint fills one empty or wrong cell from the solution, wrong digits turn red as you type, and Restart returns to the original puzzle. Any finished grid that follows the rules wins.
- Progress is saved in localStorage under `sdk-sudoku-game` after every move that changes the board and comes back after a reload; the save is removed when you win, and a broken save is replaced by a fresh puzzle.

### 7) Typing Speed Test

Path:
- `typing-speed-test/index.html`

Features:
- A random sentence from the Easy, Medium or Hard pool and a 60-second clock that starts on the first keystroke.
- Live WPM (correct characters / 5 per minute) and accuracy, with each typed character marked green (correct) or red (wrong) and the next character highlighted.
- A finished round is locked until New Game, Restart or a difficulty change; the live WPM is recomputed every second, so it falls while you pause.
- The best WPM (the final WPM of a finished round: the text completed, or the 60 s run out, scored over the full minute) and the chosen difficulty are kept in localStorage under `tst-state`. A best saved by an older version came from the live reading and may be higher.

## Local Usage

These are static games, so you can run them in either of these ways:

1. Open any target `index.html` directly in your browser.
2. Start a local static server from the repository root (recommended):

```powershell
python -m http.server 8080
```

Then open `http://localhost:8080/`. The index page lists every game by genre and has a search box;
each game also opens directly at `http://localhost:8080/<folder>/`.

The local preview configuration in `.claude/launch.json` serves the same folder with `npx serve` on
port 5175 (vahac-tools uses 5173), so both repositories can run side by side. `.gitignore` excludes
`.claude/`, so a fresh clone does not have it.

## Tests

The repository ships with a test suite covering every game and the index
page (423 tests across 10 modules: one per game, two for the Reaction Time
Test, `hub.test.js` for the index page and `_smoke.test.js` for the test
harness), powered by the built-in Node.js test runner — no external
dependencies required.

Requirements: Node.js 20 or newer for `npm test` (20.11 or later, because
several tests use `t.mock.timers.enable({ apis })`); `npm run coverage` needs
Node 22.10 or newer.

```powershell
npm test
```

`npm test` runs `tests/run.js`, which collects `tests/*.test.js` and runs them
through `node:test`'s `run()` API with the spec reporter. This works the same
on Node 20, 22 and 24 under both cmd.exe and POSIX shells — unlike
`node --test tests/` (a directory argument breaks on Node 21+) or a glob
(unsupported by `--test` on Node 20, and never expanded by cmd.exe). Every
test fails after 60 seconds, so a test that hangs fails the run instead of
blocking the Jenkins build. To run a single module, pass its path directly (on Node 20 add `--test-reporter=spec`,
or it prints TAP when the output is not a terminal):

```powershell
node --test tests/wordle-game.test.js
```

The tests are deterministic: `Math.random`, `performance.now()`, timers and
animation frames are mocked, and no game test waits on the real clock. Pure
game logic is tested through the functions each `script.js` exports to Node
(`loadScript()` from `tests/_setup.js`; the start-up code does not run under
Node). The page itself is tested booted like a browser from the game's real
`index.html` (`bootLikeBrowser()`), driven through the listeners its init
registers: clicks, keys, touches and input events. Every game's module also
checks a save in the format the first published version wrote, corrupt and
partial saves, blocked or full storage, the namespace prefix, ES5 syntax,
embed safety and the phone layout at 320–414 px. Where a behaviour is a rule
variant rather than a bug (the Snake tail cell counting as a collision, no
dictionary check in Wordle), the test pins it as it is, so a later change
shows up as a test that has to change.

- 2048 Game (35 tests): `slideRow` merging each pair once with the exact
  points gained, `rotateBoardClockwise`, the pure `moveBoard` in all four
  directions (exact boards, gained points, the changed flag, unknown
  directions ignored, the input left alone), `canMove`, `hasWon` and
  `gameStatus` (a 2048 tile shows the win even on a locked board, the win
  stays while you play on past 2048, a locked board past 2048 is Game Over),
  new tiles (2 below 0.9, otherwise 4) on the rolled cell, `swipeDirection`
  (more than 40 px, a tie goes vertical), and `parseSave`/`parseBestScore`.
  Then the page booted like a browser from `index.html`: a new game, a script
  in the page head waiting for DOMContentLoaded, a save in the first version's
  format loading and written back byte for byte, corrupt or partial saves and
  bad scores starting fresh, blocked or full storage, arrow keys that play
  without scrolling (Shift+Arrow too) while the board is in the window and
  scroll the page while it is scrolled away, but leave host-page fields,
  Ctrl/Alt/Meta and already handled keys alone, swipes, a second finger
  cancelling the swipe, New Game and Restart forgetting the old moves, undo
  through exactly the last 10 real moves with its 1.8 s toast, the message
  following the board after moves, Undo and reloads, Best never below Score, a
  reload round trip, every class, id, custom property and storage key
  prefixed tf8-, ES5 syntax and the start-up guard, embed safety, and no
  horizontal overflow from 320 to 1440 px.
- Cyberpunk Wordle (52 tests): the embedded word list kept intact (701
  five-letter entries; the ethnic slur KRAUT was removed), the answer picked
  with `Math.random`, `wrdScoreGuess` colouring repeated letters by the
  standard Wordle rule (checked against an independent reference),
  `wrdFormatTime`, `wrdOutcome` and `wrdNormalizeState`, a new game resetting
  the round but keeping the wins, typing up to five letters with Backspace,
  short guesses refused, per-letter colouring on the board, any five letters
  accepted (no dictionary check), a win counted once and locking the round, six
  misses revealing the word, the save keeping its old format through a reload,
  saves written by the previous version resuming with board, wins, clock and
  result, 36 kinds of damaged save and blocked or full storage never stopping
  the game (with full storage that can still be read, a page shown again never
  rewinds to the older save), the mm:ss clock (shown at once, restarted by New Game, never running
  twice, saved when the page is hidden), another tab's round taken over without
  lowering the wins, every listener registered once, the on-screen keyboard,
  physical keys (shortcuts, editable fields and autofill left alone), focus
  handling (Enter on a host link or button reached with Tab left to it, a
  mouse-clicked one or a typed letter giving Enter back to the game, clicked
  buttons giving the focus back, a held Enter ignored), start-up under Node, at
  once and on DOMContentLoaded, and the source checks: ids, the ES5 IIFE, the
  `wrd-` prefix, embed safety, the page background and keyboard rows that fit
  320-414 px.
- Minesweeper Game (39 tests): the three presets, empty boards and the
  neighbours of corner, edge and inner cells, adjacency (a mine cell counting
  itself, as saves have always stored it), first-click mine placement on 30
  seeded boards (exact mine count, one `Math.random` draw per mine, clicked
  cell safe, adjacency and the opened area checked against an independent
  flood fill), mine laying that always ends, flood reveal on an 18x18 board
  stopping at numbers and skipping flags, the reveal and flag rules, the save
  format (a save written by the first version, embedded literally, loads with
  its board, flags, time and counters), 30 kinds of corrupt or unplayable
  saves giving a fresh Easy board without throwing or hanging, then the page
  booted like a browser: start-up on both readyState paths and none under
  Node, New Game, Restart, the difficulty select and the r key (not with
  Ctrl, Cmd or Alt, in text fields or while composing), clicks, right-click
  flags and Enter on a focused cell, the win and the loss saved and restored
  after a reload with their status, status and toast cleared on a new board,
  a second toast kept a full 2 s, the select following a restored game,
  corrupt best times, blocked localStorage, a single clock that stops at the
  end and resumes after a reload, best times per difficulty, and static
  checks (every id in `index.html`, msp- prefixes, one ES5 IIFE, files that
  embed safely, readable cell text and an Easy board that fits every width
  from 320 px).
- Reaction Time Test (56 tests; 50 behaviour tests in `reaction-time.test.js`,
  6 source checks in `reaction-time.source.test.js`): the game booted like a
  browser from the real `index.html`, at once or on DOMContentLoaded, and
  driven by clicks, mouse presses, touches and keys with mocked
  `performance.now()`, timers and `Math.random`. Covered: the delay window of
  every difficulty, false starts by mouse, touch or Space (the pending signal
  cancelled), reactions timed at the press, the best time and the rounded
  average, and idle presses ignored. The tenth success ends the session: the
  timer stops, Play Again is focused, nothing plays behind the summary, and
  after a reload the session stays finished without covering the page, with
  Start or Enter bringing the summary back. Also covered: Restart and New Game
  closing the summary without stacking listeners, timers or signals; keys left
  to page fields, buttons and links, with Enter on the difficulty select
  starting a round; keypad and key-only Enter and Space; modifiers and
  auto-repeat ignored; Space scrolling the page only outside the game; touches
  cancelled only during a round; the session timer resuming after a reload and
  saved on hide without overwriting another tab's newer save; a save from the
  first published version; corrupt, partial, full or blocked storage; toasts;
  and the markup ids, rxt prefixes, ES5 style, embed safety and the 320–414 px
  layout.
- Snake Game (60 tests): a fresh page load drawing a 3-segment snake that waits
  behind the start prompt, a tick moving the head and dropping the tail on the
  canvas, eating (growth, 10 points, food on a free cell, toast), a best score
  that only goes up, walls and the body (the tail cell included) ending the
  game, the winning move at 150 segments with its last +10, turns that wait for
  the next tick and cannot reverse, pause and the Start/Pause/Resume label, New
  Game, Restart, Play Again and Enter, the four speeds, the clock counting every
  tick the snake moves (the eating, winning and crashing ticks included) and
  starting from zero with each new game, the keys (arrows, WASD and P in any
  case and on non-Latin layouts, Enter, held P and Enter acting once,
  Ctrl/Cmd/Alt left to the browser) taken only when the page body, the game or
  a host element holding it has the focus, the touch arrows on phones and
  touch screens, a hidden tab not piling up ticks, blocked or failing storage,
  saves written by the original version, reloads, corrupt or partial saves,
  start-up in a browser and under Node, and static checks of the markup,
  stylesheet and script (snp- prefix, ES5 syntax, embed safety, phones
  320-414 px).
- Sudoku Game (46 tests): the page files (a standalone dark page whose body
  rule build-embed never copies, sources that embed safely, the sdk prefix on
  every class, id, CSS variable, storage key and global, one strict ES5 IIFE
  with the start-up guard, every id the script looks up present in
  `index.html`, nothing wider than a 320 px phone, a wrong digit staying red
  while focused), the puzzle logic checked against an independent solution
  counter (`createEmptyBoard`, `boardToString`/`stringToGrid`, `isValid`,
  `solveBoard` on a known puzzle, a dead end and clashing givens,
  `generateSolvedBoard` reproducible from `Math.random`, an unbiased `shuffle`,
  `countSolutions`, `removeNumbers` and `generatePuzzle` making 45-blank
  puzzles with exactly one solution, `isCompleteValidGrid`, `hintCandidates`,
  `normalizeDigit`, `parseSave`), then the page booted like a browser: a first
  visit drawing, saving and toasting a fresh puzzle, waiting for
  DOMContentLoaded, buttons and the board listener wired once, a save in the
  format of every earlier version restored, corrupt saves and blocked or
  failing storage never breaking start-up, one digit 1–9 per cell, givens
  disabled, any valid finished grid winning (also on an older two-solution
  puzzle), the status following the board after a win, Hint and Restart, New
  Game and loading another save moving the givens with the puzzle so freed
  cells take digits, and a newer toast keeping its full 2 s.
- Typing Speed Test (39 tests): the three sentence pools unchanged,
  `tstIsDifficulty`, `tstPickText`, the per-character marking, WPM as correct
  characters / 5 per elapsed minute with a one-second floor, accuracy as
  correct / typed, and `tstParseSave` falling back field by field. Then the
  page booted like a browser (ready, still loading, or run from `<head>`)
  with nothing run under Node, a save in the original format loading
  unchanged, and corrupt saves or blocked/full storage never breaking the
  game. The rounds: the clock starting on the first keystroke, the live WPM
  recomputed every second and never worked out over more than 60 s after a
  suspended page, the round ending on completion (over the real time) or at 0
  (over exactly 60 s, typos counted in the accuracy) and staying locked until
  a new game, the best WPM taken only from a finished round, and a countdown
  that never passes 0. Also New Game, Restart and a difficulty change by click
  or key without leaked timers or listeners; pastes, deletions and extra
  characters; the 2 s toast; and the markup, `tst-` prefix, embed safety, ES5
  style and phone layout.
- Index page (38 tests in `hub.test.js`): the inline script of `index.html`
  booted like a browser page (at once, or on DOMContentLoaded while the
  document is still loading) with every id it looks up present and one set of
  listeners after a reload, the header, placeholder and footer counts, sections
  in `GROUPS` order with cards sorted by name, card links ending in `folder/`
  over http(s) and `folder/index.html` from disk, the description as the card
  link's tooltip, search matching every word of a query in names, descriptions
  and genre labels, the empty message (a long query wraps instead of widening
  the page), Escape clearing the box, the `/` shortcut (not in form fields or
  with Ctrl, Meta or Alt), the genre chips with their counts and the focus kept
  on a chip activated from the keyboard, an unknown genre stopping the page,
  `GAMES` matching the game folders on disk, README and the prefix registry in
  `css-template.md`, the hub- prefix, the byline link colours, ES5 and
  embed-safe code, and the phone layout at 320–414 px.
- Harness (58 tests in `_smoke.test.js`): the browser stubs in
  `tests/_setup.js` — in-memory localStorage and sessionStorage, `matchMedia`,
  element classList, style, dataset, attributes and children, text nodes, a
  no-op canvas 2D context, silent `Audio` and `AudioContext`, `vibrate` and the
  clipboard, a document whose `<html>` element holds the body — and its
  helpers: listeners and `dispatchEvent` with capture, target and bubble
  phases (`createEvent`, `keyEvent`, `touchEvent`, `fire`, `pressKey`,
  `swipe`, `listenersOf`, `listenerCount`), `click()`, `focus()` and the focus
  returning to the body when the focused element leaves the page,
  `focusElement` (blur, focusout, focus and focusin, with keyboard focus
  matching `:focus-visible`), `typeInto` (refuses disabled or read-only
  fields), `setVisibility`, element `querySelector`, `matches` and `closest`
  with simple selectors (tag, `#id`, `.class`, `[attr=value]`, `:focus`,
  `:disabled` ...), pages built from `index.html` (`createPage`,
  `htmlPageSpec`, `loadWithPage`, `bootLikeBrowser` and its unload),
  `blockStorage` (site data blocked, storage full or failing methods),
  `useClock` (mocked timers, `performance.now()` and animation frames
  together), `seeded` (a reproducible `Math.random`), `resetStubs`, the source
  checks (`idsInHtml`, `embedMarkup`, `embedSafety`, `cssRules`, `declsAt`),
  and the `package.json` scripts and coverage settings.

Code coverage of every game's `script.js`:

```powershell
npm run coverage
```

`npm run coverage` runs the same suite through `tests/run.js --coverage`
(node:test's `coverage` and `coverageIncludeGlobs: ['*/script.js']`) and prints
the coverage table after the test report. It needs Node 22.10 or newer (older
versions get a message and exit code 1) and fails when the total line, branch
or function coverage falls below its threshold in `tests/run.js`: the measured
totals rounded down to a whole percent. Today every game's `script.js` is at
100.00 % lines, 100.00 % branches and 100.00 % functions, so all three
thresholds are 100 %. Jenkins runs plain `npm test` on Node 20, so run
`npm run coverage` locally before pushing.

The index page's inline script is not in that table; on Node 22 or newer this
shows it (also at 100 %), and the same command with another file and module
measures one game:

```powershell
node --test --experimental-test-coverage --test-coverage-include=index.html tests/hub.test.js
```

Node 20 has no `--test-coverage-include`: use `--experimental-test-coverage`
alone and read the file's row.

Continuous integration runs on Jenkins (`Jenkinsfile`): it polls the `main`
branch on GitHub every two minutes and runs `npm install` and `npm test` in a
`node:20-alpine` container, so every pushed commit is tested on Node 20, and a
failed build sends a Telegram message. A manual GitHub Actions workflow
(`.github/workflows/test.yml`, `workflow_dispatch` only, Node 20 / 22 on
Ubuntu, Windows and macOS) exists only in the local folder: `.gitignore`
excludes `.github/`, so it is not in the repository and GitHub does not run
it.

## Notes

- All games are frontend-only and designed for straightforward local execution.
- Use `css-template.md` as the baseline style guide when creating or redesigning a game.
- To list a new game on the index page, add its entry (name, folder, group, description) to the `GAMES` list in `index.html` and its line under the matching genre in Repository Structure. The genres are defined in `GROUPS` in the same file; counts update by themselves.
- Every game needs its own namespace prefix for its CSS classes, element ids and localStorage keys, registered in `css-template.md`. It must also differ from every vahac-tools prefix (listed there too), because games and tools run on the same vahac.com origin and share one localStorage.
- The folder name must be unique and must not match any vahac-tools folder name. It becomes the `toolFilename` of the page's `wp:vahac/tool-embed` block, and the site writes every embed's assets, games and tools alike, to `wp-content/uploads/vahac-tools/<folder>.css` and `wp-content/uploads/vahac-tools/<folder>.js`, so two embeds with one name would overwrite each other's files.
- A game reaches the site as its three files copied into that block (the `build-embed.js` script of the vahac-tool-wp-page skill). Keep `<!--`, `-->` and `</script` out of `style.css`, `script.js` and the game's markup in `index.html`, and keep the start-up behind the readyState / `module.exports` guard so the tests can load the script.
