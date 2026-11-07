# vahac-games

A collection of standalone browser games by Vahac. Each game is implemented with plain HTML, CSS, and JavaScript, so it can run locally without a backend. The Games section on vahac.com is currently private, so the page below opens only for a logged-in site editor until the section goes public.

Documentation status:
- Last updated: 2026-11-07 (Bitmap Decoder boards up to 30x30)
- Scope synchronized with current repository structure

## Repository Structure

Games are grouped by genre, the same groups the index page (`index.html`) uses.

### Puzzle

- `2048-game/` - the 2048 sliding-tile puzzle on a 4x4 board, played with arrow keys or swipes, with undo of up to 10 moves, a best score and auto save to localStorage.
- `bitmap-decoder/` - Bitmap Decoder: nonograms whose clues are run-length encoding, with a daily 10x10 icon from a library of 55 original icons (one scored attempt per day, a streak and a share line), Endless boards from 5x5 to 30x30 (20x20 and up on screens from 768, 1024 and 1280 px) that line logic alone solves, drag painting, a timer, the best time per size and auto save to localStorage.
- `minesweeper/` - neon Minesweeper with Easy (9x9, 10 mines), Medium (14x14, 35) and Hard (18x18, 65) boards, a safe first click, right-click flags, flood reveal, a timer, the best time per difficulty and auto save to localStorage.
- `patch-panel/` - Patch Panel: turn patch-cord tiles until every server, NAS and access point on the rack links up to the core switch with no loops or dangling cables, on 5x5, 7x7 and 9x9 boards with a wrap mode whose rim marks show where cables cross to the opposite edge, tile locks, a rotation target, the best time and rotations per board, a shared 7x7 Daily with a streak and auto save to localStorage.
- `rack-reset/` - Rack Reset: press alarm LEDs on a rack's front panel until every row register reads 0, where each of six rack models flips the LEDs under its own 3x3 toggle mask written in hex, on 3x3 to 6x6 racks with an honest par from a built-in GF(2) solver, hints, undo, restart, the best presses over par per model and size and auto save to localStorage.
- `sudoku/` - classic 9x9 Sudoku with a freshly generated puzzle every game, hints, restart and auto save to localStorage.

### Word

- `regex-par/` - Regex Par: write one regular expression per hole that catches every Catch line and no Leave line, on 18 original holes made from real log and config lines (nginx, cron, dmesg, df, journald, docker-compose, ip link, ss, git, blkid), each character a stroke against par, with a scorecard, a best pattern per hole and a best round, patterns checked in a Web Worker with a 300 ms timeout (or on the main thread behind a static step limit when the page blocks workers), token chips for phones and auto save to localStorage.
- `wordle-game/` - Cyberpunk Wordle: guess a hidden five-letter word in six tries, with tiles coloured green, amber or grey, a physical or on-screen keyboard, a round timer, a win counter and auto save to localStorage.

### Arcade

- `bad-sector/` - Bad Sector: a brick breaker on an unrolled hard-disk platter: bounce the read head off the carriage through fragmented tracks of plain, bad (2-3 hits) and read-only sectors that flash their LBA when broken, with RAID1, ECC and SLOW-SEEK bonuses, SMART lives, faster tracks, a seeded Daily disk with one scored attempt, a streak and a share line, and auto save to localStorage.
- `oncall-shift/` - On-Call Shift: a 3-minute night on call on a rack of twelve servers; fix each incident (cleanup, restart, scale or renew) before its SLA runs out, stop cascades from failed databases, and get an uptime score in nines and a postmortem; the shift, the best uptime per level and the last 5 shifts are saved in localStorage.
- `snake-game/` - Snake on a 30x30 canvas grid: eat energy nodes for 10 points each, avoid the walls and your own tail, pick one of four speeds, and keep the saved game after a reload.

### Reflex and Typing

- `byte-catcher/` - Byte Catcher: a router console where queued packets carry a value and a TTL; encode each one (DEC/HEX to 8 bits in Warm-up, prefix length to mask octets and back in CIDR, the 3x3 rwx grid to octal and back in chmod) before it is dropped; three drops end the run, and auto save to localStorage.
- `reaction-time/` - reaction time test: wait for the neon signal, then click, tap or press Space; four difficulty delay windows, false-start detection, current/best/average times and a summary after 10 rounds, saved in localStorage.
- `typing-speed-test/` - 60-second typing test on a random Easy, Medium or Hard sentence, with per-character highlighting, live WPM (correct characters / 5 per minute) and accuracy, and the best WPM of finished rounds and the difficulty saved in localStorage.

### Memory and Logic

- `defrag/` - Defrag: tap a track, then another, to move the top fragment of a file onto an empty track or the same file until every file lies in one unbroken run, on 6 to 9 tracks of 4 or 5 blocks with files of different sizes and fixed system blocks, the fragmentation percentage as the live score, a par (an upper bound), a solver hint and dead-end warning, numbered levels 1-999 with the fewest moves per level, a shared Daily with a streak and auto save to localStorage.
- `hash-cracker/` - Hash Cracker: crack an Easy (4 different digits), Normal (4 different hex symbols) or Hard (5 hex symbols, repeats allowed) key in 10 attempts from HIT and NEAR counts, with a live key-space counter in keys and bits, an on-screen hex keypad, wins, losses and streaks per mode, and auto save to localStorage.
- `pod-packer/` - Pod Packer: a cluster scheduling puzzle (tap a pod, then a node) with CPU and RAM bars, anti-affinity, taints and tolerations, a draining node, an exact node target, evictions and moves as the score, and 50 fixed levels saved in localStorage.
- `port-knocker/` - Port Knocker: watch 4, 6 or 9 patch-panel ports flash a knock sequence and knock it back in Forward (FIFO), Reverse (LIFO) or Stride mode within a 3 s knock window, with a log line from round 5, a seeded Daily with one scored attempt, a streak and a share line, optional sound, and the best length per mode and panel size saved in localStorage.

### Board and Cards

- `flip-flop/` - Flip-Flop: Reversi in 1s and 0s on a memory-dump board against a computer opponent (Easy, Normal or Hard; a plain JavaScript search, no AI service) or a friend on the same device, with popcount and hex scores, an XOR flip hint, undo and auto save to localStorage.
- `swap-space-solitaire/` - Swap Space Solitaire: an open card solitaire with 8 cascades, 4 swap slots (free cells) and 4 /dev/sd* disks (foundations), two-tap moves, numbered deals you can replay, a daily deal, undo of up to 500 moves, win and daily streaks, and auto save to localStorage.

### Simulation

- `lost-in-var/` - Lost in /var: a fake shell on a broken server where real commands (ls, cd, pwd, cat, grep, tail, ps, df, kill, with pipes into grep and tail, Tab completion and history) find the cause of an incident. It has a tutorial case and two incidents (a disk filled by a looping export, a port held by the old release) that close only once the log lines naming the cause were on screen and the cause is stopped. It also has points per case (par, hints, wrong kills), command and name chips for phones, and auto save to localStorage.
- `uptime-idle/` - Uptime Idle: an idle homelab game. An old laptop running a DNS filter earns uptime credits for services (DNS filter, backup server, photo archive, media server, build farm), hardware (mini PC, NAS, virtualization node, server rack) and upgrades (RAID mirror, UPS, cooling). It has a power bill of watts x hours x price per kWh, seeded incidents (failed disk, power outage, kernel update), a session goal sized for a 3-5 minute visit, offline progress up to 8 hours, migrations to a new rack for rack points, and auto save to localStorage.

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

### 2) Bad Sector

Path:
- `bad-sector/index.html`

Features:
- Each track is an unrolled platter laid out as a fragmented disk: files of plain sectors (1 hit) and bad sectors (2 or 3 hits, labelled with their LBA), single read-only sectors that never break, and free gaps. Sectors walled in by read-only ones are left out. Later tracks have more rows, more bad and read-only sectors and faster heads.
- Physics is a fixed-step model at 120 steps a second with sub-steps of half the head's radius and a speed cap, so a fast head never passes through a thin sector. Where the head lands on the carriage sets its angle (up to 60 degrees), and a broken sector flashes its LBA address.
- Bonuses fall from some sectors: RAID1 adds a mirrored second head (from the head's own spot when the mirrored spot is inside a sector or a walled-in pocket), ECC widens the carriage for 12 s and SLOW-SEEK runs the heads at 60 % for 10 s. A lost head shows on the SMART readout and the third one fails the drive.
- Controls: the carriage follows the mouse; a finger drags it from anywhere on the platter, with no dead zone after a wall; a tap launches. Keys work only with the platter focused: Left/Right or A/D, Space launches, P pauses. The game pauses on Pause, P and a hidden tab, and resuming never runs piled-up frames.
- A game set aside (the other view, a reload) keeps its heads in flight, the carriage and falling bonuses, and comes back paused where it was, so switching views never hands a lost head back. New disk and Practice drop a scored free scan only on a second press within 4 s.
- The Daily disk is one track for everyone from the local date (shared Daily rule, #1 is 2026-11-01). It has one scored attempt written to `bds-daily` as it begins, resumed after a reload, a streak, an unscored Practice and a share line with a clipboard fallback. At local midnight the Daily button and the streak move to the new day.
- Saves in `bds-state`, `bds-best` and `bds-daily`, parsed field by field. Blocked or full storage never stops the game and the warning names each key. A second tab never overwrites a newer Daily record or another tab's best. The platter scales from 320 px phones to desktops and fits the height of a landscape phone.

### 3) Bitmap Decoder

Path:
- `bitmap-decoder/index.html`

Features:
- A nonogram whose clues are literally run-length encoding: fill cells until every row and column matches its RLE and a hidden 1-bit icon decodes. The solved icon is shown as a hex dump of its rows, ASCII art, a hex stream and its name.
- Daily: one 10x10 icon of the day from a built-in library of 55 original homelab and dev icons, picked by the shared daily rule (FNV-1a of the date fed to mulberry32, every icon once per cycle, never the same two days running). One scored attempt per day, a streak with its maximum, and a share line copied to the clipboard (or shown selected when the clipboard is unavailable).
- Endless: 5x5, 10x10, 15x15, 20x20, 25x25 or 30x30 boards made from smoothed noise and kept only when line logic alone solves them, so every puzzle has exactly one solution. Each big size is offered only on a screen wide enough for it: 15x15 over 600 px, 20x20 from 768 px, 25x25 from 1024 px and 30x30 from 1280 px (the disabled option says which). 25x25 and 30x30 widen the page to 1280 px. A narrower screen still finishes a saved big board, and its New Game makes the largest size it offers. A restarted puzzle is practice and sets no best time.
- Easy rules check every move (a wrong cell shows the truth and counts a mistake). The limit grows with the board: 3 mistakes on 5x5 and 10x10, 5 on 15x15, 6 on 20x20, 8 on 25x25 and 10 on 30x30. Relaxed checks every move the same way with no limit, and a Relaxed win sets no best time. Hard checks nothing until the grid matches. The rules switch at once on a puzzle with no moves yet; an Endless puzzle being played can also switch to Relaxed at once, keeping its mistakes.
- Tap to fill, a Fill/Mark toggle or the right mouse button to mark, and drag to paint a run (touch-action: none on the grid only). With the grid focused: arrows move, Space/Enter fill, X marks.
- The clock runs from the moment a puzzle is shown and pauses in a hidden tab. The best time is kept per size. At midnight the page shows the next Daily and the streak as of the new day.
- Saves in localStorage: `bmd-state` (mode, Endless size, rules, tool and the Endless puzzle in progress), `bmd-best` (best time per size) and `bmd-daily` (today's attempt, written the moment it begins, and the streak). Every field falls back on its own. Saves from other tabs are taken over, and a page shown again (including from the back/forward cache) reads the saves back before writing.

### 4) Byte Catcher

Path:
- `byte-catcher/index.html`

Features:
- Three modes: Warm-up (DEC and HEX to the 8 bit toggles), CIDR (/26 to the four mask octets, a dotted mask to its prefix length) and chmod (an octal mode on a 3x3 rwx grid, rwxr-x--- to its octal digits)
- An ingress queue of five packets, each with a TTL bar; a packet whose TTL runs out, or one that arrives at a full queue, is dropped, and the third drop takes the link down
- Toggles forward the oldest queued packet they match; typed entries go to the selected packet and a wrong one is a CRC error that says what it means ("255.255.255.128 is /25, not /26") on the status line inside the console
- Points are 10 plus the seconds of TTL left, times a combo of up to x4 for a clean streak; best score and most packets forwarded are kept per mode
- The pace rises quickly over four minutes and slowly up to ten, with per-mode floors set by the taps a packet needs
- Keys only while the focus is on the console (1-8 or A S D F J K L ; for bits, 1-9 for the grid and mask octets, digits, Enter, Backspace, Up/Down during a run, P); pauses on a hidden tab, comes back paused after a reload, and takes over a run another tab saved instead of writing over it

### 5) Cyberpunk Wordle

Path:
- `wordle-game/index.html`

Features:
- Six tries at a random five-letter word from a built-in list; each letter of a guess is marked correct (green), present (amber) or absent (grey), and the round ends in a win or reveals the word.
- Type on the physical keyboard or tap the on-screen QWERTY keyboard with Enter and Backspace.
- A round timer and a win counter; the current round, the timer and the wins are saved in localStorage under `wrd-state` and restored after a reload.

### 6) Defrag

Path:
- `defrag/index.html`

Features:
- A disk of 6 to 9 tracks (4 or 5 blocks each) holds the blocks of 4 to 8 files (.log, .iso, .db, .jpg ...). Tap a track to pick up its top fragment (every block of one file on top), then tap another to write it there: onto an empty track or onto the same file, only when the whole fragment fits. On phones a disk of more than five tracks stands on two shelves, so 9 tracks fit 320 px.
- Twists: from level 3 files have different sizes, and from level 5 a system file (boot.sys, swap.sys) has a fixed block at the bottom of its own track. That block never moves and the track takes no other file. The fragmentation ("fragmentation 75% → 0%") falls with every merge.
- Boards are made from the defragmented disk by legal reverse moves and kept only when the solver (an iterative-deepening search with a node cap, memoised on canonical states) proves the level's minimum number of moves. Par is the shortest route found, shown as an upper bound ("par ≤ 9").
- Hint (H) shows the solver's next move and is counted once per disk state. After every move a dead-end check warns when no route is left and says how many moves to undo. Undo has no limit up to the last 500 moves. Restart, and Prev, Next or N on a level with moves made, ask for a second press within 3 s.
- Numbered levels 1-999, each seeded from its number; the next one opens once the one before is defragmented, and the fewest moves per level are kept. Keys work only while the focus is in the game: 1-9 tracks, U undo, H hint, R restart, N next level, Escape puts a picked fragment back. A mouse click on a game button hands the keys to the disk.
- The Daily is one disk for everyone (6 files on 8 tracks), seeded from the local date (#1 is 2026-11-01). It gets one scored attempt, written when it begins and resumed after a reload, a streak of consecutive Dailies and an unscored practice run. The share line names the moves, undos and hints, with a selected-text fallback when the clipboard is unavailable.
- Saves the level game and the view (`dfg-state`), the highest level and fewest moves per level (`dfg-progress`) and the Daily attempt, result and streak (`dfg-daily`), each field checked on its own. A second open tab takes over a newer Daily, or a game of the same level that is further along, instead of overwriting it, and never erases another tab's best. Blocked or full storage shows a warning naming the keys.

### 7) Flip-Flop

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

### 8) Hash Cracker

Path:
- `hash-cracker/index.html`

Features:
- Three modes: Easy (4 different digits 0-9, 5,040 keys), Normal (4 different hex symbols 0-F, 43,680 keys) and Hard (5 hex symbols with repeats, 1,048,576 keys), with 10 attempts per key. Each attempt prints a terminal line such as `#03 $ crack 3A7F -> 2 HIT 1 NEAR`, where HIT means the right symbol in the right place and NEAR the right symbol in the wrong place. Repeated symbols are counted correctly.
- A key-space counter under every attempt shows the keys still possible, their entropy in bits and how much that attempt removed. Easy and Normal filter the full key list. Hard counts with a budget-limited pruned search, and shows n/a until few enough keys remain, so the page never stalls.
- Type on the on-screen 4x4 hex keypad (with Clear, Backspace and CRACK) or on the physical keys 0-9, A-F, Backspace and Enter. Keys that cannot be typed are disabled, and refusals name the symbol or key and the rule. Fields, links and buttons of the host page keep their keys.
- New Game or another mode switches at once while no attempt is made. Otherwise a second press within 4 s gives the key up, which counts as a loss. After a win or loss, Enter starts the next key.
- The game in progress (mode, key, attempts and the key being typed) is saved after every change under `hcr-state`. Wins, losses, the current streak and the best streak per mode are saved under `hcr-stats`. Both are restored after a reload, and a damaged save falls back field by field.

### 9) Lost in /var

Path:
- `lost-in-var/index.html`

Features:
- Three cases kept as plain data. First shift is a tutorial whose eight steps teach ls, cat, cd, tail, grep, df, ps and kill. No space left: checkout fails because a looping export filled /. Address in use: release 42 cannot bind :8080 while the release 41 server still holds it.
- A pure shell: ls -l -a -h, cd, pwd, cat, grep -i -n -v -r, tail -n, ps and ps aux (also ax, -ef, -e), df -h, and kill with -9, -TERM, -s, -n and -l, plus help and clear. It handles quotes, * and ? wildcards, and pipes into grep and tail. As in bash, every command of a pipeline runs in a subshell, so a cd there does not move the shell. Errors are worded like bash and name the path, process id or signal ("cat: /var/log/ngnix.log: No such file or directory").
- An incident closes only when its evidence was on screen (the log lines that name the cause) and the cause is stopped, in any order. A guess from ps aux is not enough. There is no rm: rm, sudo and unknown commands answer like a shell, with a note.
- Points per case: 100, minus 3 per command over par, 10 per hint and 25 per wrong process killed, at least 10. help and clear are free. A hint once seen stays seen after Restart case. The best score of each case is kept.
- Keys work only in the command field: Enter runs, Up and Down browse the history, and Tab completes a command or path when the field is not empty (on an empty field Tab moves the focus on). On phones, command chips, chips for the paths and process ids in the last output, and the ↑, ↓, Tab and Run keys solve a case by taps alone. A chip clicked with a mouse or the keyboard gives the focus back to the field.
- Saves each case's folder, kills, goals met, history, command count and hints (`liv-state`) and the best score per case (`liv-progress`). Every field falls back on its own, and blocked or full storage shows a warning naming the key. A second tab's sessions are taken over, with a note in the terminal of every case that changed, and scores from two tabs are merged, never lowered.

### 10) Minesweeper Game

Path:
- `minesweeper/index.html`

Features:
- Three preset boards: Easy (9x9, 10 mines), Medium (14x14, 35) and Hard (18x18, 65); the mines are laid after the first click and never under the clicked cell.
- Right-click flags with a live mine counter; an empty cell opens outward until it reaches numbered cells; a timer runs while you play.
- The game, its timer and its result are saved in localStorage (`msp-save-state`) on every move and every second, so a reload brings back a game in progress with its clock running or a finished game as it ended; the best time is kept per difficulty (`msp-best-easy`, `msp-best-medium`, `msp-best-hard`).

### 11) On-Call Shift

Path:
- `oncall-shift/index.html`

Features:
- Twelve generic servers on a 4x3 rack raise four kinds of incidents (full disk, memory leak, CPU at 100%, expiring certificate), each with an SLA bar. Tap an action and then the servers to fix (the action stays armed), or tap a server and then its action. A breached SLA takes the server down until it gets the right action, and a wrong action costs 4 minutes of downtime.
- Cascades: a down database, cache, queue or DNS server knocks out the servers that depend on it after a short delay, again after every fix, until the root cause is fixed. Incidents come faster and SLAs get shorter through the 3-minute shift (22:00 to 06:00 on screen).
- Easy, Normal and Hard levels. A level picked mid-shift applies from the next New Shift.
- Uptime graded in nines (always rounded down). At the end a postmortem shows the shift's numbers and the full incident timeline, and it can be copied as text.
- Keyboard while the rack has the focus: 1 to 4 choose an action, the arrows move the cursor, Enter applies, Space pauses and Escape clears. The shift pauses when the tab is hidden.
- Saved in localStorage: the shift in progress (`ocs-state`, which comes back paused after a reload), the best uptime per level (`ocs-best`) and the last 5 shifts (`ocs-history`).

### 12) Patch Panel

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

### 13) Pod Packer

Path:
- `pod-packer/index.html`

Features:
- Tap a pending pod, then a node, or a pod already running on that node. With nothing picked, a tap on a running pod evicts it. Refusals name the values, for example "Insufficient memory: pod cache-1 needs 1.5 GiB, node-3 has 0.0 GiB free."
- Rules arrive early: anti-affinity on level 2, a gpu taint with tolerations and a node selector on level 3, and a draining node on level 4. They combine from level 5 on. An eviction from the draining node is final, and Undo cannot put a pod back on it.
- Score: nodes used against a target, which is the exact minimum found by a bounded branch-and-bound search; evictions and moves against their minimums. Undo counts like doing the opposite by hand.
- 50 levels, each built constructively from the seed FNV-1a("pdp:level-N") through mulberry32, so every visitor gets the same levels and each one can be scheduled within its target under every rule it turns on.
- CPU and RAM bars for every node fit a 320 px screen in one column; two columns from 720 px. Pods are 44 px tap targets on touch screens.
- Keyboard with the focus on the cluster: arrows pick a pod, 1-6 run it on that node, E evicts, U undoes, N starts the next level, Escape clears the pick. The game's own buttons and the host page keep their keys.
- Saves the level in progress (pdp-state) and the best moves and evictions per level (pdp-progress). A damaged field falls back on its own. Blocked or full storage shows a warning naming the key, and the warning goes away once a write works again. A second tab's newer game is taken over before any action, and progress from different tabs is merged.

### 14) Port Knocker

Path:
- `port-knocker/index.html`

Features:
- A patch panel of 4, 6 or 9 RJ45-style ports (22 ssh, 80 http, 443 https, 3306, 53, 8080, 5432, 6379, 8096) flashes a knock sequence that starts at 3 and grows by one port every passed round. The show runs from 600 ms down to 250 ms per flash, and from round 5 its first ports appear in a knockd log line instead of as flashes.
- Three modes: Forward (FIFO, as shown), Reverse (LIFO, backwards) and Stride (every second port). As in a real port-knocking daemon, a 3 s knock window between knocks resets the sequence when it closes. A miss ends the run with 'Connection refused' and the order the round wanted; the score is the longest sequence repeated.
- Play by tap, click or the keys 1-9 (a numeric keypad layout on 9 ports) while the focus is in the game; Enter or Space starts a round. A hidden tab pauses the show and keeps the knock window's time left.
- Daily: one sequence a day, the same for everyone (FNV-1a + mulberry32 from the local date), on 6 ports with the mode rotating Forward/Reverse/Stride. There is one scored attempt, recorded before its first show; a reload resumes it or shows the result. The streak counts consecutive Daily wins, Share copies a result line (or selects it in a field), and a finished Daily can be replayed unscored. A result stored by another tab always stands.
- Saved in localStorage: the game on screen (`pkn-state`, a reload brings the round back waiting for Start), the best length per mode and panel size (`pkn-best`), the Daily attempt and streak (`pkn-daily`) and the sound switch (`pkn-sound`, off by default; WebAudio tones are optional).

### 15) Rack Reset

Path:
- `rack-reset/index.html`

Features:
- Six rack models (RK-272 cross, RK-525 X-link, RK-070 row bus, RK-575 H-frame, RK-632 hook, RK-777 block), each with its own 3x3 toggle mask written as three hex digits and drawn as a small stencil above the rack, on 3x3, 4x4, 5x5 and 6x6 racks. Every row of LEDs is also shown as a hex register (0x1F), and the rack is reset when every register reads 0.
- Racks are made by random presses from all-off, so every rack can be cleared. A rack that is empty or needs fewer than 3 presses (3x3) or 4 presses (4x4 and up) is drawn again. Par is the true minimum: Gaussian elimination over GF(2) that also handles singular matrices, plus a check of every solution in the null space. Only model and size pairs with at most 2^12 candidates are offered; the largest is the block on 5x5 with 512. A line under the rack shows the rank and the null-space dimension.
- Tap or click an LED to press it. With the rack focused: arrows, Space/Enter, H hint, U undo, R restart, N new game. Ctrl/Alt/Meta combinations and keys typed elsewhere on the host page are left alone. A click on Undo, Hint, Restart or New Game hands the keys back to the rack.
- Undo (the last 500 presses, kept across a reload), Restart to the rack's first state, and Hint, which marks one LED of a fewest-press reset from where the rack is now. A rack with a hint used, or replayed after it was reset, is not scored.
- With presses on the rack, a new model or size only chooses the next rack, and New Game or N has to be pressed a second time within 4 s; the toast names the rack that would be thrown away.
- Saves the rack in play (`rkr-state`) and the fewest presses over par and racks cleared per model and size (`rkr-best`) to localStorage. A second open tab takes over a newer game instead of playing on or dealing over it, and bests from two tabs are merged. Blocked or full storage shows a warning that names the keys, what a reload will show and how to fix it.

### 16) Reaction Time Test

Path:
- `reaction-time/index.html`

Features:
- A random signal delay per difficulty (Easy 2–4.5 s, Normal 1.5–3.5 s, Hard 1–2.5 s, Extreme 0.6–1.6 s); clicking before the signal is a false start and is not counted.
- The reaction time comes from `performance.now()`, rounded to ms; it shows the current, best and average time, the attempts and a session timer, and a "Session Complete" summary after 10 successful rounds. The session then stays finished, also after a reload, until Play Again, New Game or Restart; Start or Enter show the summary again.
- Mouse (the press counts, not the release), touch and keyboard: Enter starts a round, also from the difficulty select, and Space reacts. Keys typed into other page fields, buttons or links are left alone. The difficulty, the stats and the session time are saved in localStorage under `rxt-reaction-state`. The session timer resumes after a reload, and an idle second tab never overwrites a newer save.

### 17) Regex Par

Path:
- `regex-par/index.html`

Features:
- 18 original holes made from real log and config lines: nginx 5xx and request times, crontab, dmesg OOM kills, df -h, app and JSON logs, auth.log, journalctl, docker-compose images, MAC addresses, ss -tlnp, HH:MM times, release tags, private IPv4, ISO dates, commit subjects and UUIDs. Each hole has a par, and every character of the pattern is one stroke (birdie, par, bogey ...).
- Every line turns green or red while you type and the matched part is marked. An invalid pattern shows the engine's own error text and nothing else happens. Enter or Hole out scores the hole; Prev, Next and the 18-hole scorecard move between holes, and each hole keeps its draft.
- Patterns run in a Web Worker made from a Blob, which is terminated after 300 ms and replaced by a fresh one. Where the page cannot start a worker (no Worker, or a Content Security Policy that blocks blob:), patterns run on the main thread with patterns and lines of up to 60 characters. A static check counts the most backtracking steps a pattern can take on a line and refuses anything over 1,500,000, naming the part at fault, such as (a+)+, (a|a)* or (.?){20}. The line under the buttons says which mode is on.
- Phones: chips for \d \w . * + ? [] () | ^ $ {} sit just above the pattern box and insert at the caret (through the browser's insertText command where it exists, so undo takes a chip back), next to a short count such as '4/4 caught, 0/5 wrong'. A chip never takes the pattern past 200 characters.
- The first pattern that holes a hole goes on this round's card; a shorter one later still sets the hole's best. All 18 holes give a round total and the best round. New round asks for a second press within 4 s, then clears the card and drafts and keeps the bests.
- Saves the hole on screen, the round, the drafts and the card (`rxp-state`) and the shortest pattern per hole plus the best round (`rxp-best`) to localStorage, field by field. A second open tab's card, drafts, newer round and shorter bests are merged in, never written over.

### 18) Snake Game

Path:
- `snake-game/index.html`

Features:
- Arrow keys or WASD, P to pause, Enter for a new game, plus on-screen arrow buttons on phones and touch screens; WASD and P also work with Caps Lock and on non-Latin keyboard layouts. The game takes keys only while the focus is on the page, the game or the area around it, so the host page's links, buttons and fields keep theirs. Each energy node scores 10 points, the walls and your own tail end the game, and 150 segments wins it.
- Four speeds (Easy 160 ms, Normal 120 ms, Hard 85 ms, Insane 60 ms per tick), a timer of the time the snake moves (pauses excluded) and a best score.
- The whole game (snake, food, score, best score, timer, speed) is saved in localStorage under `snp-snake-state` and comes back after a reload: a running or paused game waits for the first key, and a finished game starts over with the best score and speed kept. With storage blocked the game still plays, just without saving.

### 19) Sudoku Game

Path:
- `sudoku/index.html`

Features:
- Every New Game is a fresh puzzle: a randomised backtracking solver fills the grid, then 45 cells are blanked, each only while the puzzle keeps exactly one solution.
- Hint fills one empty or wrong cell from the solution, wrong digits turn red as you type, and Restart returns to the original puzzle. Any finished grid that follows the rules wins.
- Progress is saved in localStorage under `sdk-sudoku-game` after every move that changes the board and comes back after a reload; the save is removed when you win, and a broken save is replaced by a fresh puzzle.

### 20) Swap Space Solitaire

Path:
- `swap-space-solitaire/index.html`

Features:
- All 52 cards dealt face up into 8 cascades, with 4 swap slots and 4 disks (/dev/sda-sdd, ace to king by suit). Cascades build down in alternating colours, and a run moves only while it fits (free swap slots + 1) x 2^(empty cascades). Cards no longer needed flush to the disks by themselves.
- Two taps move a card or run. Tapping the picked card again sends it to its disk or to a free swap slot. Keys with the focus in the game: 1-8, Q W E R, F, U or Ctrl+Z, Escape. Tab stops on the table once.
- Numbered deals 1-999999 from the game's own seeded shuffle (mulberry32) can be typed and replayed; no solver, so a deal is not guaranteed solvable.
- A daily deal, the same for everyone (FNV-1a of the date), scored once per day. Share copies a plain result line, Practice replays it unscored, and a daily streak is kept.
- Undo of up to 500 moves. Restart, Give Up and New Deal ask for a second press. A clock runs from the first move, and stats show page faults, won/played, streak and best.
- Saves the tab and the numbered deal (`swp-state`), the stats (`swp-stats`) and the day's attempt and daily streak (`swp-daily`) in localStorage. A second open tab's newer save is taken over, never written over, and a finished daily stays finished.

### 21) Typing Speed Test

Path:
- `typing-speed-test/index.html`

Features:
- A random sentence from the Easy, Medium or Hard pool and a 60-second clock that starts on the first keystroke.
- Live WPM (correct characters / 5 per minute) and accuracy, with each typed character marked green (correct) or red (wrong) and the next character highlighted.
- A finished round is locked until New Game, Restart or a difficulty change; the live WPM is recomputed every second, so it falls while you pause.
- The best WPM (the final WPM of a finished round: the text completed, or the 60 s run out, scored over the full minute) and the chosen difficulty are kept in localStorage under `tst-state`. A best saved by an older version came from the live reading and may be higher.

### 22) Uptime Idle

Path:
- `uptime-idle/index.html`

Features:
- Services earn credits per second and take one slot each. A mini PC, a NAS or a virtualization node adds slots and takes a place on the desk (8) or in a server rack (16 each). Each copy costs 15% more than the one before.
- A power bill on everything: watts x hours x price per kWh / 1000 (the formula of the Homelab Power Cost Calculator, named in plain text), times the PUE of the cooling level. A machine whose power would eat all of the income is refused, with the numbers.
- Incidents from a seeded PRNG: a failed disk halves the income until Replace disk (a RAID mirror makes it harmless), a power outage stops everything for 30 s (a UPS rides it out), and a kernel update gives +50% income for 60 s after Reboot.
- A session goal of about 3 minutes of income that pays 90 seconds of it as a bonus, so a short visit always gets somewhere.
- Offline progress at the net income for up to 8 hours, after closing the tab, hiding it or putting the computer to sleep. A welcome-back line names the time counted and the cap. A clock set back counts nothing until it passes the last save again, so setting it forwards and back pays the cap only once.
- Migrate to a new rack once a server rack and 300.0M cr earned in the run are reached (with a second press to confirm): the run's earnings become rack points, +2% income each, for good.
- Keys 1-9 buy the services and hardware while the focus is in the game. Saves go to `upi-state` and `upi-stats` every 5 s and after every action, and a second tab's newer save is taken over, never overwritten.

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
page (1197 tests across 25 modules: one per game, two for the Reaction Time
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
- Bad Sector (53 tests):
  - Pure logic against independent models: the cell encoding, pruning against a flood fill on 500 random grids, 240 seeded tracks, wall, carriage and sector bounces, no tunnelling at the speed cap against a fine-stepped model, hits, bonuses, the RAID1 mirror spot (sectors, read-only pockets, margins), lost heads, the cleared track and LBA flashes that fade on finished tracks.
  - The Daily: FNV-1a and mulberry32 reference values, the pinned disk of 2026-11-06, local day keys without a jump at DST changes, the streak, the share line, and which of two tabs' records wins.
  - Saves: `bdsParseState`/`bdsParseDaily`/`bdsParseBest` field by field, including heads in flight, falling bonuses, speed and carriage.
  - The page booted like a browser from `index.html`: listeners once, DOMContentLoaded, nothing under Node, focus-only keys (Ctrl/Alt/Meta, host fields, held keys), mouse and touch with a drag into a wall and back, Pause and hidden tabs with no piled-up frames, heads in flight kept paused through view switches, New disk and reloads, the confirmation for New disk and Practice, the Daily flow, midnight, second tabs, corrupt, blocked and full storage, and toasts that keep their 2.2 s.
  - Source checks: ids, the `bds-` prefix everywhere, ES5 IIFE, embed safety, canvas text of at least 9 px on a 320 px phone, and the 320-1440 px layout plus landscape phones.
- Bitmap Decoder (46 tests):
  - Pure logic: `bmdCluesOf` against an independent RLE; `bmdSolveLine` against brute force over every placement; `bmdSolveGrid` on unique, ambiguous and contradictory puzzles; every one of the 55 library icons distinct and solved by line logic alone; Endless generation at every size from 5x5 to 30x30 (3x3 majority smoothing, no mirrored boards, density bounds, reproducible from the PRNG, library fallback centred on 30x30); the daily number across DST; FNV-1a and mulberry32 against their definitions; the icon cycle against a reference written in the test; time, countdown and midnight arithmetic across European and US DST changes; the share line, hex dump and ASCII art; Easy, Relaxed and Hard moves, the mistake limit of every size and `bmdHasMoves`; `bmdParseState`, `bmdParseDaily` and `bmdParseBest` field by field.
  - The page, booted like a browser from `index.html` with timers and Date mocked: a first visit writing the Daily at once, listeners bound once, taps, marks, drags, Easy mistakes and losses, a decoded Daily with streak and best time, the streak across gaps, a Daily left open across midnight, a finished Daily that shows the new day at midnight with exactly one midnight timeout, Endless New Game, sizes and practice restarts, rules that switch at once only on a puzzle with no moves (or to Relaxed on an Endless puzzle being played), Relaxed with no limit and no best time, grid keys and filters, a clock that runs from the moment a puzzle is shown and pauses in a hidden tab, a reload round trip, takeover of other tabs' saves, a page shown again or restored from the back/forward cache that keeps a Daily won elsewhere (and keeps its own copy while storage writes fail), corrupt, partial and foreign saves, blocked and full storage, Copy result with clipboard fallbacks, toast timing, the phone size choice that shows a saved 15x15 board, and the screen widths that offer 20x20, 25x25 and 30x30 (a 30x30 board played and decoded, a saved one finished on a narrower screen).
  - Source checks: ids, the bmd prefix everywhere, ES5 syntax and the start-up guard, embed safety, the 320–414 px layout, and 20x20 to 30x30 boards beside their widest generated clue on every screen from the one that offers them up to 1280 px.
- Byte Catcher (52 tests):
  - Converters checked against independent conversions for every byte, prefix 0-32 and all 512 modes; the toggle matching brute-forced over every byte
  - The pace pinned as literal values and first-minute arrivals; players with think time plus a cost per tap last within the same band of minutes in every mode
  - The save format pinned byte for byte, field-by-field fallbacks, corrupt, blocked and full storage, a second tab, reload round trip
  - The page booted from index.html: key filters (help summary, Start and New run, pad keys, arrows only in a running run), held keys, hidden tab, writes only on a change, toasts keep their 2 s
  - Source checks: ids, byc- prefix, ES5 IIFE, embed safety, CSS rules for every class, contrast of the key hints, and the 320-414 px layout with the console and its status line within 568 px
  - 100% lines, branches and functions of `byte-catcher/script.js`.
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
- Defrag (61 tests):
  - Pure functions against an independent model: moves, reverse moves (brute force), fragments and fragmentation, the state key, and the solver against breadth-first search on random small disks. Levels 1-24 and five Dailies checked for legal scrambles, the minimum moves and par, levels 1-6 by breadth-first search and the larger ones (8 and 9 tracks, system files) by a search of the test's own.
  - The Daily: FNV-1a and mulberry32 reference values, the pinned disk of 2026-11-06, local day keys counted without a jump at daylight saving changes, the streak, the share line with undos and hints, and which of two tabs' records wins (hints count as steps).
  - Saves: `dfgParseState`/`dfgParseProgress`/`dfgParseDaily` field by field, including a move count below its own history.
  - The page booted like a browser from `index.html`: listeners bound once, a script in the head waiting for DOMContentLoaded, taps, refusals that name the tracks and files, focus-only keys (Ctrl/Alt/Meta, held keys and host-page fields left alone), a mouse click on a button handing the keys to the disk, hints counted once, dead ends, wins and bests, the second press for Restart, Prev, Next and N.
  - The Daily on the page, midnight, the clipboard fallback, second tabs for the Daily and for the level game (tap, storage event, the race between check and write), corrupt, blocked and full storage, the 500-move undo history.
  - Source checks: ids, the dfg- prefix everywhere, ES5 syntax and the IIFE, embed safety, CSS rules for every class, the 320-1440 px layout and text contrast.
- Flip-Flop (53 tests):
  - Rules and alpha-beta checked against an independent regex-based Reversi model and a plain minimax, with crafted pass, endgame and node-cap positions and level ordering.
  - The page booted from the real index.html, with listeners once, saves (current, corrupt, partial, blocked, full), the multi-tab stats merge, reload round trips, key and focus filters, the XOR preview after the CPU reply, and mocked timers and toasts.
  - Source checks for ids, prefix, ES5, embed safety and the 320–414 px layout.
  - 100% lines, branches and functions of `flip-flop/script.js`.
- Hash Cracker (43 tests): HIT/NEAR checked against an independent count (repeats included), uniform keys from one draw per symbol, the pruned search against brute force and its exact step budget, the key-space trail (Hard counted only once few enough keys are left) and 10-attempt fairness. The page is booted from the real index.html: keypad and physical keys, refusals that name their values, win, loss and give-up with a 4 s confirmation, a newer toast keeping its full 2 s, and a live log that only appends each attempt's lines. Also covered: saves (current format byte for byte, corrupt, partial, blocked and full storage, stats from another tab), reload round trips, host-page key and focus filters, listeners once, and source checks (ids, hcr prefix, ES5, embed safety, 320-414 px layout, a toast as wide as its message, touch-action: manipulation on tap targets and none anywhere).
- Lost in /var (62 tests):
  - Pure shell logic against independent models: the parser against a bash-rule word splitter on 3000 seeded lines, paths against Node's POSIX resolver, ls -h/df -h sizes in exact integer arithmetic, and every folder of every case listed and Tab-completed against the case data.
  - Every command, flag and error message: ls, cd, pwd, cat, tail, grep (closed folders under -r), ps (aux, ax, -ef, -e), df, kill (-SIG, -s, -n, -l), help, clear, unknown commands, rm and sudo. Also pipes, where a cd runs in a subshell and a kill still stops its process.
  - Goals checked on the lines shown (pipes count, empty output does not). A bounded breadth-first search shows that no incident closes in fewer than 3 commands and that guessing from ps aux never closes one. The hinted path closes within par, and the evidence stays readable after the kill.
  - Saves field by field, with a literal `liv-state` and `liv-progress` sample pinned byte for byte.
  - The page booted like a browser from `index.html`: listeners bound once, the script waiting for DOMContentLoaded, taps alone solving a case, the chip focus for mouse, keyboard, pen and touch, and keys only in the field (Ctrl/Alt/Meta and host-page fields left alone). Also hints, wrong kills, records, and Restart keeping the hints it charges.
  - Reloads, corrupt, partial, blocked and full storage, second tabs (including a case not on screen), toasts keeping their full time, and source checks: ids, the liv- prefix, ES5, embed safety, the 320-1440 px layout and a 4.5:1 contrast check of the small text.
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
- Pod Packer (47 tests):
  - Pure logic: FNV-1a and mulberry32 reference values, levels 1 and 4 pinned, generated solutions on 40 seeds per level checked by an independent rule checker, and the node target checked against a brute force (up to 8 pods). An independent subset search covers all 50 real levels and 540 levels of 10-12 pods, some with rules lifted or a node grown so the minimum drops.
  - Moves, undo (every history entry can be undone, and an eviction from the draining node is final), refusal texts, and saves parsed field by field against a literal sample save.
  - The real index.html booted like a browser: taps on pods and nodes (a tap on a running pod while a pod is picked runs the picked pod there), keys only on the cluster, focus kept across moves and level rebuilds, reload, corrupt/blocked/full storage and the warning clearing once writes work again, second tabs (taps, keys, Undo, Restart, Next level, the level list), and toasts keeping their full time.
  - Source checks: prefix, ES5 IIFE, embed safety, CSS rules for every class, the 320-1440 px layout, 44 px touch targets and 4.5:1 contrast for small texts.
  - 100% lines, branches and functions of `pod-packer/script.js`.
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
- Rack Reset (45 tests):
  - Pure functions checked against an independent BigInt GF(2) model: masks and clipped stencils, the pinned null-space dimension of all 24 model and size pairs (at most 12, the largest 9), `rkrMinPresses` against brute force on every 3x3 rack and on sampled 4x4 racks, and on 240 seeded racks the solver's answer clears the rack and is the minimum over the null space.
  - The generator: one draw per LED, redraws of empty racks and of racks below the par floor (3 on 3x3, 4 from 4x4 up) for every pair, the fallback for a stuck random source, the pinned first 5x5 cross of `seeded(1)`.
  - Keys by value, and by physical key only on non-Latin layouts (Dvorak letters do nothing). `rkrParseState` and `rkrParseBest` field by field, including a history the 500-press cap has shortened, and literal `rkr-state` and `rkr-best` samples written back byte for byte.
  - The page booted like a browser from `index.html`: listeners bound once, a script in the head waiting for DOMContentLoaded, taps and keys only with the board focused, focus handed back to the rack after a click on a button, the win and best per model and size, hints, undo up to 500 presses across a reload, Restart as an unscored replay, the second-press confirmation before a rack with presses is thrown away, toasts that keep their full time and go with their rack.
  - Second tabs (storage event, a press, Undo, Hint, Restart, New Game or a select on a stale rack, a tab shown again, merged bests), corrupt, blocked and full storage with a warning by error, and source checks: ids, the prefix, ES5 and the IIFE, embed safety, CSS rules for every class, WCAG contrast of small text and toasts, and the 320-1440 px layout (LEDs of at least 36 px, a full-width toast).
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
- Regex Par (54 tests):
  - The course: 18 holes with lines of at most 60 characters and a pinned hash. A plain-code reading of every hole's task agrees with each Catch and Leave line. A reference solution no longer than par is kept in the test, not the game, for every hole. No pattern of one or two characters holes any hole.
  - The main-thread check: `rxpBacktrack` gives the same count as a test-side backtracking matcher on lines where every atom matches, and never a lower count on real lines. `rxpIsRisky` refuses the patterns that froze the page before, naming the part and the step count. A child process (killed after 120 s) runs about 1,000 accepted fuzz patterns over all 18 holes and over worst-case lines within 250 ms each.
  - Pure functions: the quantifier reader, `rxpCompileSafe` and `rxpRunMain` limits, the worker program in a vm, `rxpReadReply`, scoring and score names, the save parsers field by field, and the two-tab merges.
  - The page booted like a browser from `index.html`: listeners bound once, a script in the head waiting for DOMContentLoaded, live colouring, invalid and refused patterns, Enter only in the pattern box (no Ctrl/Alt/Meta, no auto-repeat, host-page keys left alone), the chips (insertText, setRangeText and plain writes, the 200-character limit), a full round, New round, toasts that keep their full time and show their kind.
  - The worker sandbox with a Worker stub: the test pattern first, only the newest check queued with a dimmed 'checking' state, the 300 ms timeout with terminate() and a fresh worker, Enter waiting for a result, and main-thread fallback when the constructor throws, an error event arrives or the test pattern gets no answer.
  - Storage and sources: the save format pinned byte for byte, a reload round trip, corrupt, partial, blocked and full storage, second tabs through the storage event and re-reads before writing, a tab shown again, the prefix, ES5 syntax and the IIFE, embed safety, a CSS rule for every class, 4.5:1 contrast for toasts and informational text, and the 320-1440 px layout.
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
- Uptime Idle (54 tests):
  - Pure model checked against an independent economy model written in the test: prices, slots, places, watts and the power bill, the fixed tick, session goals, offline gain with the 8 h cap and clocks set back or far forwards, seeded incidents, purchases and their refusals (a machine that would bring the net income to 0 or below, checked across labs packed to the edge and a random buyer), the repair of a damaged save that cannot earn, and migrations. Pacing simulations: the first purchase within 30 s, the first rack within 20 minutes, a migration within about 2 hours, the power share checked every minute, and an idle lab that never overflows Number.MAX_SAFE_INTEGER. Saves are checked field by field, and a sample save is written back byte for byte.
  - The page booted like a browser from `index.html` with timers and Date.now mocked: listeners bound once, taps and keys 1-9 with the focus filters, held Enter or Space clicking once, the two-press migrate with its 400 ms gap, incidents and their accessible names, toasts keeping their time, a hidden tab and a sleeping computer counting the gap in one sum, reloads, a clock set forwards and back again paying the cap once, corrupt, partial, blocked and full storage, and second-tab takeovers (silent for routine saves).
  - Source checks: ids, the upi- prefix everywhere, ES5 syntax and the IIFE, embed safety, every class with a CSS rule, button contrast of 4.5:1 or more, and the 320-1440 px layout.
  - 100% lines, branches and functions of `uptime-idle/script.js`.
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
- Games with a Daily (Bad Sector, Bitmap Decoder, Defrag, Patch Panel, Port Knocker, Swap Space Solitaire) share
  one rule, and a new game with a Daily follows it too: the day is the local calendar date; Daily #1 is 2026-11-01 and the number counts
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
