# vahac-games

A collection of standalone browser games by Vahac. Each game is implemented with plain HTML, CSS, and JavaScript, so it can run locally without a backend. The Games section on vahac.com is currently private, so the page below opens only for a logged-in site editor until the section goes public.

Documentation status:
- Last updated: 2026-11-05 (seven new games and two new genres)
- Scope synchronized with current repository structure

## Repository Structure

Games are grouped by genre, the same groups the index page (`index.html`) uses.

### Puzzle

- `2048-game/` - the 2048 sliding-tile puzzle on a 4x4 board, played with arrow keys or swipes, with undo of up to 10 moves, a best score and auto save to localStorage.
- `bitmap-decoder/` - Bitmap Decoder: nonograms whose clues are run-length encoding, with a daily 10x10 icon from a library of 55 original icons (one scored attempt per day, a streak and a share line), Endless 5x5, 10x10 and 15x15 boards that line logic alone solves, drag painting, a timer, the best time per size and auto save to localStorage.
- `minesweeper/` - neon Minesweeper with Easy (9x9, 10 mines), Medium (14x14, 35) and Hard (18x18, 65) boards, a safe first click, right-click flags, flood reveal, a timer, the best time per difficulty and auto save to localStorage.
- `patch-panel/` - Patch Panel: turn patch-cord tiles until every server, NAS and access point on the rack links up to the core switch with no loops or dangling cables, on 5x5, 7x7 and 9x9 boards with a wrap mode whose rim marks show where cables cross to the opposite edge, tile locks, a rotation target, the best time and rotations per board, a shared 7x7 Daily with a streak and auto save to localStorage.
- `sudoku/` - classic 9x9 Sudoku with a freshly generated puzzle every game, hints, restart and auto save to localStorage.

### Word

- `wordle-game/` - Cyberpunk Wordle: guess a hidden five-letter word in six tries, with tiles coloured green, amber or grey, a physical or on-screen keyboard, a round timer, a win counter and auto save to localStorage.

### Arcade

- `oncall-shift/` - On-Call Shift: a 3-minute night on call on a rack of twelve servers; fix each incident (cleanup, restart, scale or renew) before its SLA runs out, stop cascades from failed databases, and get an uptime score in nines and a postmortem; the shift, the best uptime per level and the last 5 shifts are saved in localStorage.
- `snake-game/` - Snake on a 30x30 canvas grid: eat energy nodes for 10 points each, avoid the walls and your own tail, pick one of four speeds, and keep the saved game after a reload.

### Reflex and Typing

- `reaction-time/` - reaction time test: wait for the neon signal, then click, tap or press Space; four difficulty delay windows, false-start detection, current/best/average times and a summary after 10 rounds, saved in localStorage.
- `typing-speed-test/` - 60-second typing test on a random Easy, Medium or Hard sentence, with per-character highlighting, live WPM (correct characters / 5 per minute) and accuracy, and the best WPM of finished rounds and the difficulty saved in localStorage.

### Memory and Logic

- `hash-cracker/` - Hash Cracker: crack an Easy (4 different digits), Normal (4 different hex symbols) or Hard (5 hex symbols, repeats allowed) key in 10 attempts from HIT and NEAR counts, with a live key-space counter in keys and bits, an on-screen hex keypad, wins, losses and streaks per mode, and auto save to localStorage.
- `port-knocker/` - Port Knocker: watch 4, 6 or 9 patch-panel ports flash a knock sequence and knock it back in Forward (FIFO), Reverse (LIFO) or Stride mode within a 3 s knock window, with a log line from round 5, a seeded Daily with one scored attempt, a streak and a share line, optional sound, and the best length per mode and panel size saved in localStorage.

### Board and Cards

- `flip-flop/` - Flip-Flop: Reversi in 1s and 0s on a memory-dump board against a computer opponent (Easy, Normal or Hard; a plain JavaScript search, no AI service) or a friend on the same device, with popcount and hex scores, an XOR flip hint, undo and auto save to localStorage.
- `swap-space-solitaire/` - Swap Space Solitaire: an open card solitaire with 8 cascades, 4 swap slots (free cells) and 4 /dev/sd* disks (foundations), two-tap moves, numbered deals you can replay, a daily deal, undo of up to 500 moves, win and daily streaks, and auto save to localStorage.

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

### 2) Bitmap Decoder

Path:
- `bitmap-decoder/index.html`

Features:
- A nonogram whose clues are literally run-length encoding: fill cells until every row and column matches its RLE and a hidden 1-bit icon decodes. The solved icon is shown as a hex dump of its rows, ASCII art, a hex stream and its name.
- Daily: one 10x10 icon of the day from a built-in library of 55 original homelab and dev icons, picked by the shared daily rule (FNV-1a of the date fed to mulberry32, every icon once per cycle, never the same two days running). One scored attempt per day, a streak with its maximum, and a share line copied to the clipboard (or shown selected when the clipboard is unavailable).
- Endless: 5x5, 10x10 or 15x15 boards made from smoothed noise and kept only when line logic alone solves them, so every puzzle has exactly one solution; 15x15 is desktop-only. A restarted puzzle is practice and sets no best time.
- Easy rules check every move (a wrong cell shows the truth and counts a mistake; three end the game). Hard checks nothing until the grid matches. The rules switch at once on a puzzle with no moves yet.
- Tap to fill, a Fill/Mark toggle or the right mouse button to mark, and drag to paint a run (touch-action: none on the grid only). With the grid focused: arrows move, Space/Enter fill, X marks.
- The clock runs from the moment a puzzle is shown and pauses in a hidden tab. The best time is kept per size. At midnight the page shows the next Daily and the streak as of the new day.
- Saves in localStorage: `bmd-state` (mode, Endless size, rules, tool and the Endless puzzle in progress), `bmd-best` (best time per size) and `bmd-daily` (today's attempt, written the moment it begins, and the streak). Every field falls back on its own. Saves from other tabs are taken over, and a page shown again (including from the back/forward cache) reads the saves back before writing.

### 3) Cyberpunk Wordle

Path:
- `wordle-game/index.html`

Features:
- Six tries at a random five-letter word from a built-in list; each letter of a guess is marked correct (green), present (amber) or absent (grey), and the round ends in a win or reveals the word.
- Type on the physical keyboard or tap the on-screen QWERTY keyboard with Enter and Backspace.
- A round timer and a win counter; the current round, the timer and the wins are saved in localStorage under `wrd-state` and restored after a reload.

### 4) Flip-Flop

Path:
- `flip-flop/index.html`

Features:
- Standard Reversi rules on an 8x8 board drawn as a neon memory dump: you write 1s and move first, the opponent writes 0s, passes are automatic, and the most bits win (ties allowed)
- Opponents: CPU Easy (a random move weighted by the bits it flips), CPU Normal (alpha-beta, 2 plies), CPU Hard (iterative-deepening alpha-beta, 5 plies or to the end with 10 cells left, with move ordering, mobility and a node cap), or two players on one device. The CPU is plain local JS with no network
- Scores as popcount of each side's 64-bit hex mask, plus a dump panel with every row's address, bits and hex per side
- XOR hint toggle: legal moves show how many bits they flip, and hovering or focusing one previews exactly which bits flip
- Undo of the full turn, and a New Game that asks for confirmation in the middle of a game
- Keyboard play while the focus is in the game (arrows, Enter/Space, U, N), plus click and tap
- Game auto-saved in `localStorage` under `ffl-state` (board, turn, opponent, undo history, hint toggle, last move)
- Wins, losses and draws per CPU level under `ffl-stats`, re-read before each result so a second open tab never overwrites it
- Blocked or full storage never stops the game, and a warning names each key that is not saved

### 5) Hash Cracker

Path:
- `hash-cracker/index.html`

Features:
- Three modes: Easy (4 different digits 0-9, 5,040 keys), Normal (4 different hex symbols 0-F, 43,680 keys) and Hard (5 hex symbols with repeats, 1,048,576 keys), with 10 attempts per key. Each attempt prints a terminal line such as `#03 $ crack 3A7F -> 2 HIT 1 NEAR`, where HIT means the right symbol in the right place and NEAR the right symbol in the wrong place. Repeated symbols are counted correctly.
- A key-space counter under every attempt shows the keys still possible, their entropy in bits and how much that attempt removed. Easy and Normal filter the full key list. Hard counts with a budget-limited pruned search, and shows n/a until few enough keys remain, so the page never stalls.
- Type on the on-screen 4x4 hex keypad (with Clear, Backspace and CRACK) or on the physical keys 0-9, A-F, Backspace and Enter. Keys that cannot be typed are disabled, and refusals name the symbol or key and the rule. Fields, links and buttons of the host page keep their keys.
- New Game or another mode switches at once while no attempt is made. Otherwise a second press within 4 s gives the key up, which counts as a loss. After a win or loss, Enter starts the next key.
- The game in progress (mode, key, attempts and the key being typed) is saved after every change under `hcr-state`. Wins, losses, the current streak and the best streak per mode are saved under `hcr-stats`. Both are restored after a reload, and a damaged save falls back field by field.

### 6) Minesweeper Game

Path:
- `minesweeper/index.html`

Features:
- Three preset boards: Easy (9x9, 10 mines), Medium (14x14, 35) and Hard (18x18, 65); the mines are laid after the first click and never under the clicked cell.
- Right-click flags with a live mine counter; an empty cell opens outward until it reaches numbered cells; a timer runs while you play.
- The game, its timer and its result are saved in localStorage (`msp-save-state`) on every move and every second, so a reload brings back a game in progress with its clock running or a finished game as it ended; the best time is kept per difficulty (`msp-best-easy`, `msp-best-medium`, `msp-best-hard`).

### 7) On-Call Shift

Path:
- `oncall-shift/index.html`

Features:
- Twelve generic servers on a 4x3 rack raise four kinds of incidents (full disk, memory leak, CPU at 100%, expiring certificate), each with an SLA bar. Tap an action and then the servers to fix (the action stays armed), or tap a server and then its action. A breached SLA takes the server down until it gets the right action, and a wrong action costs 4 minutes of downtime.
- Cascades: a down database, cache, queue or DNS server knocks out the servers that depend on it after a short delay, again after every fix, until the root cause is fixed. Incidents come faster and SLAs get shorter through the 3-minute shift (22:00 to 06:00 on screen).
- Easy, Normal and Hard levels. A level picked mid-shift applies from the next New Shift.
- Uptime graded in nines (always rounded down). At the end a postmortem shows the shift's numbers and the full incident timeline, and it can be copied as text.
- Keyboard while the rack has the focus: 1 to 4 choose an action, the arrows move the cursor, Enter applies, Space pauses and Escape clears. The shift pauses when the tab is hidden.
- Saved in localStorage: the shift in progress (`ocs-state`, which comes back paused after a reload), the best uptime per level (`ocs-best`) and the last 5 shifts (`ocs-history`).

### 8) Patch Panel

Path:
- `patch-panel/index.html`

Features:
- 5x5, 7x7 and 9x9 boards plus a wrap mode whose edges join like a torus, each generated as a random spanning tree around the core switch and scrambled. Tap or click turns a tile clockwise; Lock mode or a mouse/pen right-click locks it (an Android long press locks nothing). With the board focused: arrows, Space/Enter, Q (back), L (lock), N (new game).
- Cables reached from the switch light green and carry packets out from it; a loop glows red as a broadcast storm and unanswered cable ends turn amber. A hex hint shows the cursor tile's link mask.
- Wrap boards show how the edges join: the board options say "(edges join)", a note under the board explains it, and a mark on the rim beside every row and column shows each crossing. Where cables meet across the rim each end takes its tile's colour (green on the switch's network, red in a loop, cyan on a dark tile); an unanswered cable is amber beside a live tile (like an open end inside the board) and grey beside a dark one; the mark is faint where no cable crosses. A rim tile under the cursor and the tile across the rim from it share a dashed outline, and the hint names where the rim edges continue ("wraps W→E3"); on phones the hint keeps two lines on wrap boards, so the page does not jump.
- Stats for ports up, rotations, a target (the generated solution's rotations, an upper bound), time, the best time and fewest rotations per board, and the Daily streak. A scored win offers the next rung of the ladder: 5x5, 7x7, 9x9, then the same with wrap.
- Restart puts the board back to its scramble. Once a tile was turned, the run is an unscored replay; New Game deals a scored board.
- The Daily is a 7x7 board for everyone, seeded from the local date (#1 is 2026-11-01). It gets one scored attempt, written when it begins and resumed after a reload. Its clock runs while it is on screen. A solved Daily offers an unscored practice run, and the result line can be copied to share.
- Saves the free game and the view (`ppn-state`), the best per board (`ppn-best`) and the Daily attempt, result and streak (`ppn-daily`) to localStorage. A second open tab takes over a newer Daily instead of overwriting it, and never erases another tab's best.

### 9) Port Knocker

Path:
- `port-knocker/index.html`

Features:
- A patch panel of 4, 6 or 9 RJ45-style ports (22 ssh, 80 http, 443 https, 3306, 53, 8080, 5432, 6379, 8096) flashes a knock sequence that starts at 3 and grows by one port every passed round. The show runs from 600 ms down to 250 ms per flash, and from round 5 its first ports appear in a knockd log line instead of as flashes.
- Three modes: Forward (FIFO, as shown), Reverse (LIFO, backwards) and Stride (every second port). As in a real port-knocking daemon, a 3 s knock window between knocks resets the sequence when it closes. A miss ends the run with 'Connection refused' and the order the round wanted; the score is the longest sequence repeated.
- Play by tap, click or the keys 1-9 (a numeric keypad layout on 9 ports) while the focus is in the game; Enter or Space starts a round. A hidden tab pauses the show and keeps the knock window's time left.
- Daily: one sequence a day, the same for everyone (FNV-1a + mulberry32 from the local date), on 6 ports with the mode rotating Forward/Reverse/Stride. There is one scored attempt, recorded before its first show; a reload resumes it or shows the result. The streak counts consecutive Daily wins, Share copies a result line (or selects it in a field), and a finished Daily can be replayed unscored. A result stored by another tab always stands.
- Saved in localStorage: the game on screen (`pkn-state`, a reload brings the round back waiting for Start), the best length per mode and panel size (`pkn-best`), the Daily attempt and streak (`pkn-daily`) and the sound switch (`pkn-sound`, off by default; WebAudio tones are optional).

### 10) Reaction Time Test

Path:
- `reaction-time/index.html`

Features:
- A random signal delay per difficulty (Easy 2–4.5 s, Normal 1.5–3.5 s, Hard 1–2.5 s, Extreme 0.6–1.6 s); clicking before the signal is a false start and is not counted.
- The reaction time comes from `performance.now()`, rounded to ms; it shows the current, best and average time, the attempts and a session timer, and a "Session Complete" summary after 10 successful rounds. The session then stays finished, also after a reload, until Play Again, New Game or Restart; Start or Enter show the summary again.
- Mouse (the press counts, not the release), touch and keyboard: Enter starts a round, also from the difficulty select, and Space reacts. Keys typed into other page fields, buttons or links are left alone. The difficulty, the stats and the session time are saved in localStorage under `rxt-reaction-state`. The session timer resumes after a reload, and an idle second tab never overwrites a newer save.

### 11) Snake Game

Path:
- `snake-game/index.html`

Features:
- Arrow keys or WASD, P to pause, Enter for a new game, plus on-screen arrow buttons on phones and touch screens; WASD and P also work with Caps Lock and on non-Latin keyboard layouts. The game takes keys only while the focus is on the page, the game or the area around it, so the host page's links, buttons and fields keep theirs. Each energy node scores 10 points, the walls and your own tail end the game, and 150 segments wins it.
- Four speeds (Easy 160 ms, Normal 120 ms, Hard 85 ms, Insane 60 ms per tick), a timer of the time the snake moves (pauses excluded) and a best score.
- The whole game (snake, food, score, best score, timer, speed) is saved in localStorage under `snp-snake-state` and comes back after a reload: a running or paused game waits for the first key, and a finished game starts over with the best score and speed kept. With storage blocked the game still plays, just without saving.

### 12) Sudoku Game

Path:
- `sudoku/index.html`

Features:
- Every New Game is a fresh puzzle: a randomised backtracking solver fills the grid, then 45 cells are blanked, each only while the puzzle keeps exactly one solution.
- Hint fills one empty or wrong cell from the solution, wrong digits turn red as you type, and Restart returns to the original puzzle. Any finished grid that follows the rules wins.
- Progress is saved in localStorage under `sdk-sudoku-game` after every move that changes the board and comes back after a reload; the save is removed when you win, and a broken save is replaced by a fresh puzzle.

### 13) Swap Space Solitaire

Path:
- `swap-space-solitaire/index.html`

Features:
- All 52 cards dealt face up into 8 cascades, with 4 swap slots and 4 disks (/dev/sda-sdd, ace to king by suit). Cascades build down in alternating colours, and a run moves only while it fits (free swap slots + 1) x 2^(empty cascades). Cards no longer needed flush to the disks by themselves.
- Two taps move a card or run. Tapping the picked card again sends it to its disk or to a free swap slot. Keys with the focus in the game: 1-8, Q W E R, F, U or Ctrl+Z, Escape. Tab stops on the table once.
- Numbered deals 1-999999 from the game's own seeded shuffle (mulberry32) can be typed and replayed; no solver, so a deal is not guaranteed solvable.
- A daily deal, the same for everyone (FNV-1a of the date), scored once per day. Share copies a plain result line, Practice replays it unscored, and a daily streak is kept.
- Undo of up to 500 moves. Restart, Give Up and New Deal ask for a second press. A clock runs from the first move, and stats show page faults, won/played, streak and best.
- Saves the tab and the numbered deal (`swp-state`), the stats (`swp-stats`) and the day's attempt and daily streak (`swp-daily`) in localStorage. A second open tab's newer save is taken over, never written over, and a finished daily stays finished.

### 14) Typing Speed Test

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
page (765 tests across 17 modules: one per game, two for the Reaction Time
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
- Bitmap Decoder (42 tests):
  - Pure logic: `bmdCluesOf` against an independent RLE; `bmdSolveLine` against brute force over every placement; `bmdSolveGrid` on unique, ambiguous and contradictory puzzles; every one of the 55 library icons distinct and solved by line logic alone; Endless generation (3x3 majority smoothing, mirroring, density bounds, reproducible from the PRNG, library fallback); the daily number across DST; FNV-1a and mulberry32 against their definitions; the icon cycle against a reference written in the test; time, countdown and midnight arithmetic across European and US DST changes; the share line, hex dump and ASCII art; Easy and Hard moves and `bmdHasMoves`; `bmdParseState`, `bmdParseDaily` and `bmdParseBest` field by field.
  - The page, booted like a browser from `index.html` with timers and Date mocked: a first visit writing the Daily at once, listeners bound once, taps, marks, drags, Easy mistakes and losses, a decoded Daily with streak and best time, the streak across gaps, a Daily left open across midnight, a finished Daily that shows the new day at midnight with exactly one midnight timeout, Endless New Game, sizes and practice restarts, rules that switch at once only on a puzzle with no moves, grid keys and filters, a clock that runs from the moment a puzzle is shown and pauses in a hidden tab, a reload round trip, takeover of other tabs' saves, a page shown again or restored from the back/forward cache that keeps a Daily won elsewhere (and keeps its own copy while storage writes fail), corrupt, partial and foreign saves, blocked and full storage, Copy result with clipboard fallbacks, toast timing, and the phone size choice that shows a saved 15x15 board.
  - Source checks: ids, the bmd prefix everywhere, ES5 syntax and the start-up guard, embed safety, and the 320–414 px layout.
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
- Flip-Flop (53 tests):
  - Rules and alpha-beta checked against an independent regex-based Reversi model and a plain minimax, with crafted pass, endgame and node-cap positions and level ordering.
  - The page booted from the real index.html, with listeners once, saves (current, corrupt, partial, blocked, full), the multi-tab stats merge, reload round trips, key and focus filters, the XOR preview after the CPU reply, and mocked timers and toasts.
  - Source checks for ids, prefix, ES5, embed safety and the 320–414 px layout.
  - 100% lines, branches and functions of `flip-flop/script.js`.
- Hash Cracker (43 tests): HIT/NEAR checked against an independent count (repeats included), uniform keys from one draw per symbol, the pruned search against brute force and its exact step budget, the key-space trail (Hard counted only once few enough keys are left) and 10-attempt fairness. The page is booted from the real index.html: keypad and physical keys, refusals that name their values, win, loss and give-up with a 4 s confirmation, a newer toast keeping its full 2 s, and a live log that only appends each attempt's lines. Also covered: saves (current format byte for byte, corrupt, partial, blocked and full storage, stats from another tab), reload round trips, host-page key and focus filters, listeners once, and source checks (ids, hcr prefix, ES5, embed safety, 320-414 px layout, a toast as wide as its message, touch-action: manipulation on tap targets and none anywhere).
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
- On-Call Shift (49 tests):
  - The pure shift model checked against an independent copy of the rack's wiring and the level table:
    - SLA timers to the tick, breaches and downtime per tick, the 1.5 s wrong-action penalty, cascades that fire only while the upstream is down and are cancelled by fixing the root, and rising spawn rates.
    - Uptime rounded down and graded in nines, the shift clock and durations, the cursor on the 4x3 rack, tile views, postmortem lines and the report.
    - Saves parsed field by field.
  - Balance pinned by simulation:
    - A 1 s-per-fix bot keeps Normal at 99.9% or better, and an idle player is below 99% after 30 s.
    - A 1.5 s bot keeps every Normal shift at two nines, and a human-paced model reaches two nines on 8 or more of 10 Normal seeds.
    - A 2 s bot separates Easy, Normal and Hard.
  - The page booted like a browser from `index.html`:
    - Listeners once, start and one tick per 100 ms, and both tap orders.
    - Keys on the rack. Keys outside the game, in its fields, with modifiers or already handled are left alone, and so are arrows on its buttons and every key after the shift ends.
    - A mouse click on Start shift / Pause / Resume hands the keys to the rack.
    - Pause, the overlay and hidden tabs with no piled-up ticks. Reload round trips.
    - The end of the shift with best and history recorded once.
    - A level change mid-shift waiting for New Shift, with shift numbers only for shifts that ran.
    - Toasts, the clipboard fallback, blocked or full storage, and corrupt saves.
  - Source checks: ids, the ocs- prefix everywhere, ES5 syntax, embed safety, the 320-414 px layout, and the rack plus the action bar fitting a 320 px tall landscape screen.
- Patch Panel (60 tests):
  - Pure functions checked against an independent board model: rotations and symmetry periods, edges with and without wrap, the rim crossings of wrap boards with the look of each end (a loop across the rim and an open end on boards of their own), the tiles across the rim and the hint, open ends, the switch's network and uplinks, loop cells. 240 seeded boards are spanning trees with at most three links a tile and are never scrambled solved, plus the fallback for a stuck random source and the target count.
  - The Daily: FNV-1a and mulberry32 reference values, the pinned board of 2026-11-05, local day keys counted without a jump at daylight saving changes, the streak, the share line, and which of two tabs' Daily records wins.
  - Saves: `ppnParseState`/`ppnParseDaily`/`ppnParseBest` field by field, 19 kinds of unplayable save, the best merge.
  - The page booted like a browser from `index.html`: listeners bound once (window only for `storage`), a script in the head waiting for DOMContentLoaded, taps, locks and an Android long press that locks nothing, keys only with the board focused (Ctrl/Alt/Meta and host-page fields left alone), the wrap cursor, the win, best per board, the ladder, Restart as an unscored replay that can no longer beat the best, the free clock and the Daily clock that runs while on screen (hidden tab, background tab, reload).
  - The Daily on the page: one attempt written at once, no Restart while in progress, the toast naming the free game New Game or Practice replaces, the streak, midnight, the clipboard fallback.
  - Second tabs: free play, ticks and hiding never touch `ppn-daily`; a newer record is taken over at a tap, a lock, a tick, on opening or through the storage event; a record from after today never blocks.
  - Storage and sources: saves in the current format written back byte for byte, a reload round trip, corrupt, blocked and full storage, the prefix, ES5 syntax, embed safety, and the 320-1440 px layout (tiles of at least 30 px, stat values that wrap instead of being cut off, the board's glow and focus ring inside its scroll box).
- Port Knocker (44 tests): the pure logic checked against independent models:
  - `pknExtendSequence` never repeats the last port; `pknExpectedOrder` for Forward, Reverse and Stride; `pknCheckInput`, the scores, rounds and pace.
  - The show timeline with the log line from round 5, and the keypad key mapping.
  - The Daily rule: local day key, DST-safe number, FNV-1a written with BigInt, mulberry32, the day's sequence and mode.
  - The streak, the share line, `pknLaterDaily`, and the field-by-field parsers.

  Then the page booted like a browser from `index.html`:
  - Listeners once, start-up on both readyState paths and none under Node, the show at its pace with knocks ignored, passes and misses, the knock window, the log line, 6- and 9-port panels.
  - Key and focus filters (selects, modifiers, held keys), taps that never block scrolling, New Game/Restart/select changes without leaked timers, a reload round trip, hidden-tab pauses.
  - Corrupt, partial, blocked and full storage, best scores merged across tabs, the toast's full 2.2 s.
  - The Daily: attempt mark before the first show, resume, result, streak, Share with clipboard fallbacks, midnight, unscored replay. A Daily finished in another tab is taken over at every scored step and never written over, and a newer stored record keeps the streak.
  - The Daily button's state-dependent accessible name, and optional WebAudio sound.

  Source checks: ids, the `pkn-` prefix, ES5 IIFE, embed safety, the 320-414 px layout.
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
- Swap Space Solitaire (51 tests):
  - Rules and deals: the mulberry32 shuffle and the FNV-1a daily seed against independent implementations; canMove against an independent rules model on random positions; the supermove limit, safe autoplay, refusal texts, deadlock, win and run counts; daily numbers and streaks.
  - Saves: boards, histories and all three saves read field by field; the page booted from index.html with every listener bound once; two-tap and key play with the host-page key and focus filters; Tab stops (the table once, every card at tabindex -1); Undo with its 500-move cap.
  - Confirms and daily: two-press Restart, Give Up and New Deal/Play; the clock with mocked timers (paused while hidden, never saved on ticks); the daily scored once, Practice, Share with clipboard fallbacks, and the midnight rules and texts; reload round trips, the current save format byte for byte, corrupt, partial, blocked and full storage, and toasts.
  - Other tabs: a daily won in another tab while this one was hidden survives showing, hiding and closing it and is never scored twice; storage events, taps, keys, buttons and Enter that find a newer save; behind saves are kept out and written back; stats merging; no write-back loops.
  - Source checks: ids, swp prefix, ES5, embed safety and the 320 px layout.
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
- Games with a Daily (Bitmap Decoder, Patch Panel, Port Knocker, Swap Space Solitaire) share one rule, and a new
  game with a Daily follows it too: the day is the local calendar date; Daily #1 is 2026-11-01 and the number counts
  UTC days from it (DST-safe); the content is seeded with the FNV-1a hash of `<prefix>:<YYYY-MM-DD>` through
  mulberry32, never `Math.random`; the attempt is saved under `<prefix>-daily` as it begins, so a reload resumes it
  or shows its result and it is scored once (a practice replay is not scored); the streak counts consecutive Daily
  numbers won; Share copies one plain-text line, or shows it selected when the clipboard is unavailable; a Daily
  left open across midnight finishes as the day it started. Nothing is sent anywhere: every player gets the same
  board because the seed comes from the date.
- To list a new game on the index page, add its entry (name, folder, group, description) to the `GAMES` list in `index.html` and its line under the matching genre in Repository Structure. The genres are defined in `GROUPS` in the same file; counts update by themselves.
- Every game needs its own namespace prefix for its CSS classes, element ids and localStorage keys, registered in `css-template.md`. It must also differ from every vahac-tools prefix (listed there too), because games and tools run on the same vahac.com origin and share one localStorage.
- The folder name must be unique and must not match any vahac-tools folder name. It becomes the `toolFilename` of the page's `wp:vahac/tool-embed` block, and the site writes every embed's assets, games and tools alike, to `wp-content/uploads/vahac-tools/<folder>.css` and `wp-content/uploads/vahac-tools/<folder>.js`, so two embeds with one name would overwrite each other's files.
- A game reaches the site as its three files copied into that block (the `build-embed.js` script of the vahac-tool-wp-page skill). Keep `<!--`, `-->` and `</script` out of `style.css`, `script.js` and the game's markup in `index.html`, and keep the start-up behind the readyState / `module.exports` guard so the tests can load the script.
