# vahac-games

A collection of standalone browser games by Vahac. Each game is implemented with plain HTML, CSS, and JavaScript, so it can run locally without a backend. The Games section on vahac.com is currently private, so the page below opens only for a logged-in site editor until the section goes public.

Documentation status:
- Last updated: 2026-11-04 (repository created from the seven games on the site, grouped by genre here and on the index page)
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
- `typing-speed-test/` - 60-second typing test on a random Easy, Medium or Hard sentence, with per-character highlighting, live WPM (correct characters / 5 per minute) and accuracy, and the best WPM and difficulty saved in localStorage.

### Other files

- `index.html` - index page that lists every game by genre, with search.
- `css-template.md` - shared CSS/style guidance for game pages and the namespace prefix registry.

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
- The game in progress and its timer are saved in localStorage (`msp-save-state`) on every move and every second, and the best time is kept per difficulty (`msp-best-easy`, `msp-best-medium`, `msp-best-hard`).

### 4) Reaction Time Test

Path:
- `reaction-time/index.html`

Features:
- A random signal delay per difficulty (Easy 2–4.5 s, Normal 1.5–3.5 s, Hard 1–2.5 s, Extreme 0.6–1.6 s); clicking before the signal is a false start and is not counted.
- The reaction time comes from `performance.now()`, rounded to ms; it shows the current, best and average time, the attempts and a session timer, and a "Session Complete" summary after 10 successful rounds.
- Mouse, touch and keyboard (Enter starts a round, Space reacts); the difficulty and the stats are saved in localStorage under `rxt-reaction-state`.

### 5) Snake Game

Path:
- `snake-game/index.html`

Features:
- Arrow keys or WASD, P to pause, Enter for a new game, plus on-screen arrow buttons on mobile; each energy node scores 10 points, the walls and your own tail end the game, and 150 segments wins it.
- Four speeds (Easy 160 ms, Normal 120 ms, Hard 85 ms, Insane 60 ms per tick), a timer and a best score.
- The whole game (snake, food, score, best score, timer, speed) is saved in localStorage under `snp-snake-state` and comes back after a reload.

### 6) Sudoku Game

Path:
- `sudoku/index.html`

Features:
- Every New Game is a fresh puzzle: a randomised backtracking solver fills the grid, then 45 cells are blanked.
- Hint fills one empty or wrong cell from the solution, wrong digits turn red as you type, and Restart returns to the original puzzle.
- Progress is saved in localStorage under `sdk-sudoku-game` after every move and comes back after a reload; the save is removed when you win.

### 7) Typing Speed Test

Path:
- `typing-speed-test/index.html`

Features:
- A random sentence from the Easy, Medium or Hard pool and a 60-second clock that starts on the first keystroke.
- Live WPM (correct characters / 5 per minute) and accuracy, with each typed character marked green (correct) or red (wrong) and the next character highlighted.
- The best WPM and the chosen difficulty are kept in localStorage under `tst-state`.

## Local Usage

These are static games, so you can run them in either of these ways:

1. Open any target `index.html` directly in your browser.
2. Start a local static server from the repository root (recommended):

```powershell
python -m http.server 8080
```

Then open `http://localhost:8080/`. The index page lists every game by genre and has a search box;
each game also opens directly at `http://localhost:8080/<folder>/`.

The preview configuration in `.claude/launch.json` serves the same folder with `npx serve` on port
5175 (vahac-tools uses 5173), so both repositories can run side by side.

## Tests

The repository ships with a unit-test suite covering the core logic of every
game (111 tests across 8 modules: one per game plus `_smoke.test.js` for the
test harness), powered by the built-in Node.js test runner — no external
dependencies required.

Requirements: Node.js 20 or newer (20.11 or later, because several tests use
`t.mock.timers.enable({ apis })`).

```powershell
npm test
```

`npm test` runs `tests/run.js`, which collects `tests/*.test.js` and runs them
through `node:test`'s `run()` API with the spec reporter. This works the same
on Node 20, 22 and 24 under both cmd.exe and POSIX shells — unlike
`node --test tests/` (a directory argument breaks on Node 21+) or a glob
(unsupported by `--test` on Node 20, and never expanded by cmd.exe). To run a
single module, pass its path directly:

```powershell
node --test tests/wordle-game.test.js
```

Each module loads the game's real `script.js` with `loadScript()` from
`tests/_setup.js`. The start-up code does not run under Node, and the tests
drive the functions the script exports through stub elements, mocked timers,
a mocked `Math.random` and an in-memory localStorage. Where the game on the site
has a known quirk, the test pins the current behaviour, so a later fix shows up
as a test that has to change.

- 2048 Game (11 tests): `slide` merging each pair only once with the exact
  score, `rotateBoardClockwise` (a quarter turn, four turns give the identity,
  the input is left alone), moves in all four directions with exact boards,
  scores and the changed flag, `canMove` and `has2048`, new tiles (2 below 0.9,
  otherwise 4) on the chosen cell, the best score and the save after a move but
  not after a blocked one, the Game Over and 2048 messages (the win message
  replaces Game Over when both apply), undo through exactly the last 10 moves
  and its 1.8 s toast, a save surviving a fresh page load, Restart keeping the
  best score, and every id the script looks up existing in `index.html`.
- Cyberpunk Wordle (14 tests): the embedded word list kept intact (702
  five-letter entries), the answer picked with `Math.random`, a new game
  resetting the round but keeping the wins, typing up to five letters with
  Backspace, short guesses refused, per-letter colouring, the duplicate-letter
  colouring and the missing dictionary check pinned as they are, a win counted
  once and locking the round, six misses revealing the word, a reload
  round-trip, `init()` starting a new game or resuming a saved one, the mm:ss
  timer stopping when the round ends, and the on-screen keyboard rows.
- Minesweeper Game (12 tests): the three presets and a fresh board, first-click
  mine placement on 30 seeded boards (exact mine count, clicked cell safe,
  adjacency and the opened area checked against an independent flood fill),
  adjacency at the edges and diagonals, flood reveal stopping at numbers and
  skipping flags, the win (status, toast, best time, saved win) and the loss
  (every mine shown, clock stopped, board frozen), flags and the mine counter,
  best times compared as numbers per difficulty, a save/load round-trip with
  the clock resuming, missing or corrupt saves, the unsaved loss pinned as it
  is, and every id in `index.html` with files that embed safely.
- Reaction Time Test (14 tests): the delay window of every difficulty at its
  minimum, midpoint and maximum, false starts (nothing counted, the pending
  signal cancelled), a reaction measured with a mocked `performance.now()`
  through the Enter and Space handlers, the best time and the rounded average,
  idle clicks ignored, the tenth success ending the session, Restart and New
  Game, a reload round-trip, empty or corrupt storage falling back to defaults,
  the session timer through animation frames, and every id in `index.html` with
  files that embed safely.
- Snake Game (16 tests): a reset to a 3-segment snake, a tick moving the head
  and dropping the tail, eating food (growth, 10 points, food respawned on a
  free cell, toast), a best score that only goes up, walls and the body (the
  tail cell included) ending the game, direction changes that wait for the next
  tick and cannot reverse, the keys (arrows, WASD, P, Enter; capitals ignored),
  pause, the win at 150 segments, `snpFormatTime`, save/load round-trips, a
  restored lost game crashing again on the next tick, and corrupt saves.
- Sudoku Game (14 tests): `createEmptyBoard`, `boardToString`, `isValid` for
  rows, columns and boxes, `solveBoard` on a known puzzle and on a dead end
  (guesses undone), generated grids that are complete, valid and reproducible
  from `Math.random`, `removeNumbers` blanking exactly the requested cells on a
  copy, `shuffle`, then the page itself: New Game drawing a 45-blank puzzle,
  saving it and showing the toast for 2 s, a save restored after a reload with
  the wrong entry marked, input kept to one digit 1–9, the last digit winning
  and clearing the save, Hint fixing one wrong or empty cell, and Restart
  keeping the puzzle and its solution.
- Typing Speed Test (13 tests): the three sentence pools, `tstPickText`, the
  per-character marking, WPM as correct characters / 5 per elapsed minute and
  accuracy as correct / typed, the one-second floor at the start, the best WPM
  saved only when it is beaten, the `tst-state` round-trip, `tstInit` restoring
  the saved game and binding the controls, the clock starting on the first
  keystroke and the round ending on completion or at 0 with the WPM of the last
  keystroke, a difficulty change mid-round, the 2 s toast, and every id in
  `index.html`.
- Harness (17 tests in `_smoke.test.js`): the browser stubs in
  `tests/_setup.js` — animation frames that run only when a test calls
  `flushAnimationFrames()`, separate in-memory localStorage and sessionStorage,
  `matchMedia`, element classList, style, dataset, attributes and children, a
  no-op canvas 2D context, silent `Audio` and `AudioContext`, `vibrate` and the
  clipboard.

Tests run on demand via GitHub Actions
(`.github/workflows/test.yml`) — the workflow uses `workflow_dispatch` only, so
nothing executes automatically on push or pull request. Trigger it manually
from the **Actions** tab in GitHub ("Run workflow"); inputs let you pick a
specific Node version (20 / 22) or runner OS (Ubuntu / Windows / macOS), or
leave both blank to run the full matrix.

## Notes

- All games are frontend-only and designed for straightforward local execution.
- Use `css-template.md` as the baseline style guide when creating or redesigning a game.
- To list a new game on the index page, add its entry (name, folder, group, description) to the `GAMES` list in `index.html` and its line under the matching genre in Repository Structure. The genres are defined in `GROUPS` in the same file; counts update by themselves.
- Every game needs its own namespace prefix for its CSS classes, element ids and localStorage keys, registered in `css-template.md`. It must also differ from every vahac-tools prefix (listed there too), because games and tools run on the same vahac.com origin and share one localStorage.
- The folder name must be unique and must not match any vahac-tools folder name. It becomes the `toolFilename` of the page's `wp:vahac/tool-embed` block, and the site writes every embed's assets, games and tools alike, to `wp-content/uploads/vahac-tools/<folder>.css` and `wp-content/uploads/vahac-tools/<folder>.js`, so two embeds with one name would overwrite each other's files.
- A game reaches the site as its three files copied into that block (the `build-embed.js` script of the vahac-tool-wp-page skill). Keep `<!--`, `-->` and `</script` out of `style.css`, `script.js` and the game's markup in `index.html`, and keep the start-up behind the readyState / `module.exports` guard so the tests can load the script.
