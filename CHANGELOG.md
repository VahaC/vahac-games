# Changelog

All notable changes to this repository are recorded here, newest first. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the
games are not versioned, so each entry is dated.

## [2026-11-05] - Seven new games

Seven games join the collection, each in its own folder with the usual three plain files, its own
namespace prefix and its own test module at 100 % line, branch and function coverage. None of them uses
an AI service, a network call or an outside resource: the computer opponent of Flip-Flop is a plain
JavaScript search. Four of them (Bitmap Decoder, Patch Panel, Port Knocker, Swap Space Solitaire) share
one Daily rule, now described in README Notes. Every game was reviewed independently after it was built,
and the review findings were fixed before release.

### Index page

#### Added
- Two genres: Memory and Logic (Hash Cracker, Port Knocker) and Board and Cards (Flip-Flop, Swap Space
  Solitaire). Patch Panel and Bitmap Decoder join Puzzle, and On-Call Shift joins Arcade. The page now
  lists 14 games in 6 genres.

#### Tests
- `tests/hub.test.js` follows the new lists: the counts, the genre chips, the listing by genre, search and
  the README and prefix registry checks.

### Bitmap Decoder

#### Added
- New game `bitmap-decoder/` (prefix `bmd`): a nonogram whose clues are
  run-length encoding. A solved grid decodes a hidden 1-bit icon, shown as a
  hex dump, ASCII art, a hex stream and the icon name.
- Daily mode: one 10x10 icon per day from a library of 55 original homelab
  and dev icons, picked by the shared daily rule (FNV-1a + mulberry32, every
  icon once per cycle, never the same icon two days running). One scored
  attempt per day, written at once to `bmd-daily`, a streak with its maximum,
  and a share line with a clipboard fallback.
- Endless mode: 5x5, 10x10 and 15x15 boards from smoothed noise, kept only
  when line logic alone solves them, with a library fallback. 15x15 is
  desktop-only. A restarted puzzle is practice and sets no best time.
- Easy rules count mistakes (three end the game); Hard rules check only the
  finished grid. New rules apply at once to a puzzle with no moves yet,
  otherwise from the next puzzle.
- Tap, Fill/Mark toggle, right-click marks, drag painting on the grid only,
  and keyboard play on the focused grid.
- A clock that runs from the moment a puzzle is shown and pauses in a hidden
  tab, the best time per size (`bmd-best`), and a re-render at local midnight
  for the next Daily and the streak as of the new day.
- Saves in `bmd-state`, `bmd-best` and `bmd-daily` that fall back field by
  field. Saves from other tabs are taken over. A page shown again (tab switch,
  back/forward cache, frozen tab) reads the saves back before writing, so a
  Daily won elsewhere stays won.

#### Tests
- `tests/bitmap-decoder.test.js`, 42 tests:
  - The line solver against brute force; every library icon solved by line
    logic alone; Endless generation; the daily rule against an independent
    reference; midnight arithmetic across DST.
  - The page booted from `index.html`: saves in every damaged form, a reload
    round trip, takeover from other tabs and from a page shown again or
    restored from the back/forward cache, blocked and full storage, the clock
    with mocked timers, the midnight re-render with a single timeout, rules
    switching only on a puzzle with no moves, and the phone size choice.
  - Source checks: prefix, ES5, embed safety, 320–414 px.
- 100% lines, branches and functions of `bitmap-decoder/script.js`.

### Flip-Flop

#### Added
- New game `flip-flop/` (prefix `ffl-`): Reversi in 1s and 0s on a neon memory-dump board, with standard rules, automatic passes and ties allowed.
- Play against a local computer (Easy: random move weighted by flips; Normal: alpha-beta, 2 plies; Hard: iterative-deepening alpha-beta, 5 plies or to the end with 10 cells left, with move ordering, mobility and a 30,000-node cap) or two players on one device. The computer moves after a 450 ms delay, and input is ignored while it thinks.
- Popcount and hex scores, a memory-dump panel, and an XOR hint toggle that marks legal moves with their flip count. The hover/focus preview of the flipped bits comes back by itself after the computer's reply.
- Undo of the full turn, a New Game that asks for confirmation (its aria-label changes too), keyboard play inside the game, and touch play.
- Saves under `ffl-state` and `ffl-stats`, both parsed field by field. Stats are re-read and merged before each result, so a second open tab no longer overwrites a win or loss.
- The blocked or full storage warning names every key that failed and what it holds. The move log is a `role="status"` region, so screen readers hear moves, refusals and the New Game prompt.

#### Tests
- `tests/flip-flop.test.js`: 53 tests.
  - An independent Reversi model and minimax, crafted pass, endgame and node-cap positions, and level ordering.
  - The page booted like a browser, with saves (current, corrupt, partial, blocked, full), the multi-tab stats merge, reload round trips, key and focus filters, the XOR preview after the CPU reply, mocked timers, and source checks.
  - 100% lines, branches and functions of `flip-flop/script.js`.

### Hash Cracker

#### Added
- New game `hash-cracker/`: crack a hidden key in 10 attempts from HIT and NEAR counts, in Easy (4 different digits), Normal (4 different hex symbols) or Hard (5 hex symbols with repeats). A terminal log prints every attempt with the keys still possible and their entropy in bits. Hard counts its million keys with a budget-limited pruned search and shows n/a until few enough remain.
- An on-screen hex keypad and the physical keys 0-9, A-F, Backspace and Enter. Refusals name their values. Giving up a key that has attempts needs a second press within 4 s and counts as a loss.
- Saves in `hcr-state` (the game in progress) and `hcr-stats` (wins, losses, current and best streak per mode). Damaged, blocked or full storage never breaks the game.
- A review pass fixed four small issues before release:
  - Toasts use the full phone width instead of half of it.
  - The keypad, mode and New Game buttons set `touch-action: manipulation`, so quick double taps no longer zoom the page on iOS.
  - An attempt only appends its own lines to the live log instead of rebuilding it, so screen readers hear only the new feedback.

#### Tests
- `tests/hash-cracker.test.js`: 43 deterministic tests (Math.random and timers mocked everywhere), 100% line, branch and function coverage of `hash-cracker/script.js`.

### On-Call Shift

#### Added
- New arcade game `oncall-shift/`: a 3-minute night on call (22:00 to 06:00 on screen) on a rack of twelve generic servers.
  - Each incident (full disk, memory leak, CPU at 100%, expiring certificate) needs one action (cleanup, restart, scale or renew) before its SLA runs out. A breached SLA takes the server down, and a wrong action adds downtime.
  - A down database, cache, queue or DNS server cascades to the servers that depend on it.
- Easy, Normal and Hard levels. Normal is tuned so a player who needs about 1.5 s per fix keeps two nines. A level picked mid-shift applies from the next New Shift, and shift numbers count only shifts that ran.
- Uptime graded in nines and a postmortem with the shift's numbers and its full timeline, copyable as text. The best uptime per level and the last 5 shifts are kept.
- Tap an action then servers, or a server then its action. A mouse or touch click on any game control hands the keys to the rack.
- Keyboard on the rack: 1-4, the arrows, Enter, Space and Escape. Keys outside the game, on its buttons' Enter, Space and arrows, and after the shift ends stay with the page.
- The shift pauses on a hidden tab and comes back paused after a reload. Saves go to `ocs-state`, `ocs-best` and `ocs-history`.
- Phone layouts from 320 px wide and a compact layout for screens up to 420 px tall (landscape phones).

#### Tests
- `tests/oncall-shift.test.js` (49 tests), with 100% line, branch and function coverage of `oncall-shift/script.js`:
  - The pure shift model against an independent model.
  - Balance simulations: a 1 s and a 1.5 s bot and a human-paced player on Normal, and a 2 s bot across the levels.
  - The page booted from `index.html`: input and focus rules, pause and hidden tabs, reloads, the end of the shift, level changes, storage failures and corrupt saves.
  - Source checks, including the 320-414 px widths and the 320 px landscape height.

### Patch Panel

#### Added
- A new puzzle game: turn the patch-cord tiles of a homelab rack until every server, NAS and access point links up to the core switch, with no loops (broadcast storm) and no dangling cables.
- Boards: 5x5, 7x7 and 9x9, plus a wrap mode. Each is a random spanning tree around the switch, scrambled and never solved at the start.
- Controls: tap or click to turn a tile. Lock mode or a mouse/pen right-click locks a tile; an Android long press locks nothing. Keyboard controls work only while the board has the focus.
- Live link-up, packet, storm and open-end highlighting, and a hex hint for the cursor tile.
- Wrap boards explain themselves: the options read "5x5 wrap (edges join)", a note under the board says how the edges join, marks on the rim beside every row and column light up where a cable crosses to the opposite edge (each end in its tile's colour where the cables meet: green, red in a loop, cyan on a dark tile; amber or grey where a cable gets no answer), a rim tile and the tile across the rim from it share a dashed outline, and the hint names where the rim edges continue ("wraps W→E3"). On screens up to 359 px a wrap board keeps 5 px of padding for the marks, and every board still fits 320 px.
- Stats and progress: a rotation target (an upper bound), the time, the best time and fewest rotations per board, and a ladder of board sizes.
- Restart: once a tile was turned, a restarted board is an unscored replay, so a memorised board cannot set a best.
- The Daily: a 7x7 board for everyone, seeded from the local date, following DAILY_RULE. It has one scored attempt, a clock that runs while the Daily is on screen, a streak, an unscored practice run and a share line with a clipboard fallback.
- Saves under `ppn-state`, `ppn-best` and `ppn-daily`, parsed field by field. Blocked or full storage never stops the game.
- Second tabs: a second tab takes over a newer Daily record instead of overwriting it, both before every write and through the storage event, and a new best is merged with the one on disk.

#### Tests
- `tests/patch-panel.test.js` with 60 tests:
  - Pure board logic against an independent model, Daily seeding and day numbering, which of two tabs' Daily records wins, and saves field by field.
  - The page booted from `index.html`: input, locks and long press, focus-only keys, the win, best and replay rules, the free and the Daily clock, and the wrap rim (placement, looks after every turn and once solved, the outlined tile across, the note).
  - The Daily flow, second-tab takeovers, corrupt, blocked and full storage, and source checks with the 320-1440 px layout.
- 100% line, branch and function coverage of `patch-panel/script.js`.

### Port Knocker

#### Added
- New memory game `port-knocker/` (prefix `pkn-`): a homelab patch panel of 4, 6 or 9 ports flashes a knock sequence that grows by one port per round. The player knocks it back in Forward (FIFO), Reverse (LIFO) or Stride (every second port) mode within a 3 s knock window. The show speeds up from 600 to 250 ms, and from round 5 it starts with a knockd log line. The result is 'ssh: connection established' or 'Connection refused', and the score is the longest sequence repeated.
- Daily mode: one seeded sequence a day for everyone (FNV-1a + mulberry32 from the local date) on 6 ports with a rotating mode and one scored attempt, recorded before its first show. A reload resumes it, and it has a streak, a Share line with a clipboard fallback and an unscored replay. A result stored by another tab stands: a stale tab takes it and never writes over it, and a new Daily builds its streak on the latest stored record.
- Saves in `pkn-state`, `pkn-best` (per mode and panel size), `pkn-daily` and `pkn-sound` (sound off by default). Corrupt, partial, blocked or full storage never stops the game.
- Keyboard 1-9 (numpad layout on 9 ports), Enter/Space only with the focus in the game, touch that never blocks page scrolling, hidden-tab pausing, and the Daily button's accessible name following its state.

#### Tests
- `tests/port-knocker.test.js` (44 tests): the pure logic against independent models; the page booted from the real `index.html` (rounds, modes, knock window, log line, keys and focus, touch, timers, saves, reloads, storage failures, the Daily and its multi-tab cases); and source checks (ids, prefix, ES5, embed safety, 320-414 px layout). 100 % lines, branches and functions of `port-knocker/script.js`.

### Swap Space Solitaire

#### Added
- New game `swap-space-solitaire/`: an open card solitaire of the Baker's Game family with 8 cascades, 4 swap slots and 4 /dev/sd* disks.
  - Alternating-colour building, the (free swap slots + 1) x 2^(empty cascades) run limit, and safe autoplay to the disks.
  - Two-tap moves on phones; keys 1-8, Q W E R, F, U / Ctrl+Z and Escape on desktop.
- Numbered deals 1-999999 from the game's own seeded shuffle, which can be typed and replayed. They match no other program's deals, and none is guaranteed solvable.
- A daily deal scored once per day, with Share, an unscored Practice and a daily streak. A daily left open past midnight finishes as its own day and then says the next one is open.
- Undo of up to 500 moves. Restart, Give Up and New Deal ask for a second press. A clock, page faults, won/played, streaks and best are shown.
- Saves in `swp-state`, `swp-stats` and `swp-daily`, read field by field. Blocked or full storage shows a warning that names the keys. The clock is saved with moves, on hide and on close, never on ticks.
- A second open tab never overwrites your progress. Another tab's newer save is taken over at once, and an older one is never allowed to undo a finished daily or lost wins.
- Tab stops on the card table once instead of on every card.

#### Tests
- `tests/swap-space-solitaire.test.js`, 51 tests:
  - Rules and deals checked against independent models.
  - Saves of every kind, including corrupt, partial, blocked and full storage, and the reload round trip.
  - Keys, focus and Tab stops; two-press confirms, the clock and the daily rules across midnight.
  - Two tabs: a hidden tab shown again, closed, or getting storage events; taps and keys that find a newer save; behind saves; no write-back loops.
  - Source and 320 px layout checks.
- 100% lines, branches and functions of `swap-space-solitaire/script.js`.

## [2026-11-04] - Refactor of all games and full test coverage

Every game's `script.js` was rewritten as one strict ES5 script in clear
sections (constants, state, pure game logic, saves, rendering, input,
start-up), with its elements looked up at start-up instead of while the script
loads. The look of every game is unchanged apart from the visible fixes listed
below, every localStorage key and save format is unchanged, and a save written
by the first published version still loads. Every storage access is guarded,
so blocked or full browser storage never stops a game, and a damaged save
starts a fresh game instead of breaking the page. The suite grew from 143 to
423 tests, and every game's `script.js` is now at 100 % line, branch and
function coverage.

### 2048 Game

#### Changed
- `script.js` rewritten around pure, tested functions (`slideRow`, `moveBoard`,
  `gameStatus`, `parseSave`, `swipeDirection`); the old Node exports `slide`,
  `has2048` and the `move*` functions became `slideRow`, `hasWon` /
  `gameStatus` and `moveBoard`. In `style.css` two colours now use the
  existing `--tf8-bg-secondary` variable and three invalid `//` declarations
  that browsers already ignored were removed.
- Arrow keys play only while at least part of the board is in the window.
  While the board is scrolled away they scroll the host page as before and
  leave the board alone (the first version moved the tiles unseen).

#### Fixed
- A damaged save no longer leaves an empty board on which every arrow key
  fails: a fresh game starts. A text score, a negative score or unknown tile
  values in the save no longer show up on the board.
- A move that changes nothing no longer uses up one of the 10 undo steps.
- Undo now takes back the Game Over or win message along with the move.
- New Game and Restart forget the old game's moves, so Undo cannot bring the
  old board back.
- Arrow keys no longer scroll the page while you play on a visible board.
- Arrow keys typed into a text field of the host page, and Ctrl, Alt or Cmd
  shortcuts, no longer move the tiles. Shift+Arrow still plays.
- Blocked or full storage no longer stops the game from starting, and Game
  Over and the win message still show.
- After a reload the win or Game Over message shows again for the saved board.
- A second toast no longer disappears early.
- A two-finger touch (a pinch) no longer counts as a swipe.
- Best never shows less than Score after a reload.
- The game also starts when its script is placed in the page head.

#### Tests
- 14 tests became 35, booted from the real `index.html`: a save in the first
  version's format loads and is written back byte for byte, corrupt saves,
  blocked storage, the keyboard filters, the swipe and second-finger rules,
  the message after Undo and reloads (including a board that locks after you
  play on past 2048, which shows Game Over), and the 320-1440 px layout.

### Cyberpunk Wordle

#### Changed
- `script.js` rewritten with pure, tested rules (`wrdScoreGuess`, `wrdOutcome`,
  `wrdFormatTime`, `wrdNormalizeState`); every old Node export is kept. The
  wrapper gradient in `style.css` now uses the theme variables (pixel-identical).
- The ethnic slur KRAUT was removed from the word list (now 701 entries).
  Saves whose answer is KRAUT still load.
- The clock is no longer written to the save every second; the game saves when
  the page is hidden, and another tab's round is taken over at once.
- Known corners of the focus fix: a host-page button reached with Tab and then
  clicked while it already has the focus keeps Enter (before, Enter submitted
  the guess); after the round ends, a held Enter on a host control focused by
  the mouse is cancelled after its first keydown.

#### Fixed
- A damaged save no longer breaks the game: a fresh game starts and keeps your
  win count.
- Blocked or full storage no longer stops the game.
- Repeated letters are coloured by the standard Wordle rule (a letter is only
  marked present as many times as the answer still has it).
- A second open tab no longer overwrites your progress and wins every second.
- The timer shows the right time at once after a reload and after New Game, a
  finished round no longer comes back as 00:00, and the first second of a new
  round lasts a full second.
- Enter on a link, button or summary of the host page reached with Tab now
  works instead of submitting the guess; after a mouse click on such a control,
  or after typing a letter, Enter submits the guess as before.
- Space after clicking New Game or Restart no longer throws the round away, and
  Space after tapping an on-screen key no longer types it again.
- Reloading a finished round shows its result again, so a lost round reveals
  the word.
- Holding Enter on the last guess no longer wipes the result from the screen.
- The game also starts when its script is placed in the page head.

#### Tests
- 25 tests became 52: the colouring checked against an independent reference,
  36 kinds of damaged save, saves of the previous version, full storage that
  can still be read, the clock, two tabs,
  every listener registered once, and the host-page focus rules. The old test
  that pinned the non-standard colouring of repeated letters now asserts the
  standard rule.

### Minesweeper Game

#### Changed
- `script.js` rewritten; the saved state no longer holds the timer handle (the
  save keeps every old field, `interval` is always `null`), and clicks and
  right-clicks go through one listener on the board. `mspCheckWin` was replaced
  by the pure `mspIsWin`.
- The cell size is a `--msp-cell-size` variable (42 px on desktop, smaller
  steps down to 26 px under 360 px).
- The r restart shortcut is also ignored while the difficulty select has the
  focus, because a select uses letter keys to jump between options.

#### Fixed
- Revealed numbers are readable; they were black on a near-black background.
- On phones (320-414 px) the Easy board fits, and Medium and Hard scroll inside
  their panel from the first column; columns used to be cut off and
  unreachable.
- Ctrl+R (reload), Alt+R or Cmd+R, and typing r in a text field, no longer
  restart the game and wipe the save.
- A lost game is saved, so a reload no longer undoes the fatal click.
- The status text and the toast clear on New Game, Restart, a difficulty change
  or r.
- The difficulty select shows the difficulty of a restored game, so New Game no
  longer switches to another difficulty.
- A damaged save no longer breaks the page or freezes it on the first click; a
  fresh Easy board starts.
- A second toast within 2 s stays up its full 2 s.
- Reloading a finished game shows its result instead of "Awaiting tactical
  deployment."
- A corrupt best time shows as none, and the next win replaces it.
- Blocked storage no longer stops the game.

#### Tests
- 13 tests became 39: first-click mine placement on 30 seeded boards against an
  independent flood fill, 30 kinds of corrupt or unplayable save, a save of the
  first version, wins and losses restored after a reload, the r shortcut
  filters, and the phone layout. The test that pinned the unsaved loss now
  asserts that the loss is saved.

### Reaction Time Test

#### Changed
- `script.js` rewritten; the Node exports that only tests used are gone. The
  only change to `style.css` is its final newline.
- A finished session stays finished: after the 10th round nothing plays behind
  the summary, and a session that was finished before a reload shows "Session
  Complete" on the board without covering the page; Start or Enter show the
  summary again.
- The session time is also saved when the tab is hidden or closed, and that
  save never overwrites what another tab of the game saved since.

#### Fixed
- Enter on a focused New Game or Restart button no longer also starts a round.
- A mouse reaction counts at the press: pressing early and releasing after the
  signal is a false start, and holding the button no longer adds to your time.
- Typing into other fields, buttons or links of the host page no longer
  controls the game.
- A damaged save or an unknown difficulty no longer breaks the game.
- Blocked or full storage no longer stops the game.
- The session timer resumes after a reload instead of starting again at 0.0s.
- The timer no longer shows -0.0s after a restart.
- A second toast stays up its full 2.2 s.
- Keypad Enter works, and Ctrl, Alt or Cmd combinations and held keys no
  longer trigger the game.
- New Game or Restart while the summary is open closes it.
- Space scrolls the page again when no round is running.
- A damaged save no longer puts an error in the host page's browser console
  (the game already started fresh).
- On a phone, the tap that ends the session no longer dismisses the summary at
  once.

#### Tests
- 15 tests became 56 (50 behaviour tests plus 6 source checks in the new
  `reaction-time.source.test.js`), driven through the real listeners: false
  starts by mouse, touch and Space, the end of a session and its reload, the
  host-page key rules, two tabs, and corrupt, full or blocked storage.

### Snake Game

#### Changed
- `script.js` rewritten: one interval asks for at most one animation frame at a
  time, and the clock adds up the length of every tick. The save no longer
  holds the timer handles (`loop`, `timerLoop`), which the game never read
  back. A corrupt save is no longer logged to the console.
- On Latin keyboard layouts such as Dvorak, the keys in the W, A, S, D and P
  positions also play, besides the labelled letters.

#### Fixed
- The toast no longer blocks taps on the touch arrows under it.
- Blocked storage no longer stops the game, and storage that fails mid-game no
  longer freezes the board.
- Enter, the arrows, WASD and P work again on the host page's links, buttons
  and fields; the game took them.
- A damaged save loads as a playable game.
- Coming back to a hidden tab no longer runs a burst of moves at once, and the
  timer no longer counts while the tab is hidden.
- The timer counts the time the snake moves, to the tick, and every new game
  starts it from zero.
- The winning move shows its last +10 and draws the head on the last cell.
- WASD and P work with Caps Lock and on non-Latin keyboard layouts.
- Holding P no longer toggles pause over and over, and holding Enter no longer
  starts game after game.
- The on-screen arrows show on touch screens wider than 768 px (phones held
  sideways, tablets).

#### Tests
- 28 tests became 60: drawing on the canvas, eating, the win, the clock on
  eating, winning and crashing ticks, the keys and the focus rules, touch
  arrows, hidden tabs, blocked storage, saves of the original version and
  corrupt saves. Running into the tail cell still ends the game, as the README
  describes.

### Sudoku Game

#### Changed
- `script.js` rewritten: the 81 inputs are built once and updated in place, so
  the focus survives Hint, Restart and New Game, and the solver tries the most
  constrained cell first. In `style.css` a wrong digit keeps its red
  background while focused (see Fixed).
- Input that leaves a cell unchanged (a rejected letter, or the same digit
  typed again) no longer saves and no longer shows the "Game saved" toast.

#### Fixed
- Every new puzzle has exactly one solution. Before, most puzzles had several,
  a correct grid could be marked red and never win, and Hint could break it.
  Any finished grid that follows the rules now wins, also on an older saved
  puzzle with two solutions.
- A damaged save no longer breaks start-up or shows "undefined" in cells.
- Blocked or full storage no longer breaks start-up or stops the win.
- A cell holds one digit; several digits in one cell no longer shift the board
  and the save.
- A wrong digit stays red while its cell has the focus.
- The "Victory!" toast no longer disappears after a fraction of a second.
- After a win, changing a digit clears "Puzzle solved!", and fixing it wins
  again.

#### Tests
- 17 tests became 46: the puzzle logic against an independent solution
  counter, one solution for every generated puzzle, a save of every earlier
  version, corrupt saves, failing storage, and the givens following each new
  puzzle.

### Typing Speed Test

#### Changed
- `script.js` rewritten around pure, tested functions (`tstWpm`,
  `tstAccuracy`, `tstComputeStats`, `tstParseSave`); the Node exports that only
  tests used are gone. `style.css` and `index.html` were only re-indented.
- Best WPM now comes only from a finished round (the text completed, or the
  60 s run out, scored over the full minute). A best saved by an older version
  came from the live reading and may be higher than a new round can reach.

#### Fixed
- A damaged save no longer leaves the page without a sentence and with dead
  buttons.
- A non-numeric, negative or infinite best WPM in the save no longer shows as
  it is or blocks a new best.
- After the time runs out or the sentence is finished, the round is locked:
  more typing no longer changes the stats, raises the best or shows the result
  again.
- Best WPM is no longer inflated by a fast first keystroke.
- The final WPM when the time runs out is scored over the full 60 s, and the
  live WPM is recomputed every second, so it falls while you pause.
- The countdown never goes below 0.
- A later toast stays up its full 2 s, and New Game hides the old toast.
- The game also starts when its script is placed in the page head.
- Blocked or full storage no longer stops the game.

#### Tests
- 14 tests became 39. The two tests that pinned the old scoring now assert the
  fixed one (time-up scored over exactly 60 s, best only from a finished
  round). The countdown test that failed on Node 20, the version Jenkins runs,
  passes there now.

### Index page

#### Changed
- The page starts on DOMContentLoaded while the document is still loading.
- A search text already in the box when the page starts is used; a `GAMES`
  entry with a group such as `toString` now stops the page as an unknown genre.
- The byline link colours come from a more specific selector instead of
  `!important` (same colours).

#### Fixed
- Choosing a genre chip with the keyboard keeps the focus on that chip.
- A long search without spaces no longer makes the page scroll sideways.
- A card's full description shows as a tooltip when you hover the card.
- The genre colour variable carries the hub- prefix (`--hub-group`).

#### Tests
- New `hub.test.js` with 38 tests: the inline script booted like a browser,
  search, chips, links, `GAMES` against the game folders, README and the prefix
  registry, and the phone layout.

### Test harness and tooling

#### Added
- `tests/_setup.js` grew into a shared harness: element, document and window
  listeners with capture and bubble phases; `createEvent`, `keyEvent`,
  `touchEvent`, `fire`, `pressKey` and `swipe`; pages built from a game's
  `index.html` (`createPage`, `htmlPageSpec`, `loadWithPage`) and
  `bootLikeBrowser`, which runs a game the way a browser does; source checks
  (`idsInHtml`, `embedMarkup`, `embedSafety`, `cssRules`, `declsAt`).
- Helpers the game tests asked for: `focusElement` (focus moving with its
  events, keyboard focus matching `:focus-visible`), `typeInto`,
  `setVisibility`, `blockStorage`, `useClock` (timers, `performance.now()` and
  animation frames together), `seeded`, a `document.documentElement`, simple
  selectors for element `querySelector`, `matches` and `closest`, and the focus
  returning to the body when the focused element leaves the page.
- `readRepoFile` turns CRLF line endings into LF, so the source checks also
  pass on a Windows checkout with `core.autocrlf=true`.
- Every test fails after 60 s (`timeout` in `tests/run.js`), so a hung test
  fails the Jenkins build instead of blocking it. `package.json` now asks for
  Node 20.11 or newer, the version the tests need.
- `npm run coverage` (Node 22.10+): coverage of every game's `script.js`,
  failing below 100 % lines, branches or functions.

#### Changed
- The suite has 423 tests in 10 modules (143 in 8 before) and runs in about
  3 s on Node 20 and Node 24.
- The README's CI paragraph now describes the Jenkins build; the GitHub Actions
  workflow it described is ignored by `.gitignore` and not in the repository.
