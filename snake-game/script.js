// Snake Game — script.js
// Prefix: snp-
// Dependencies: none.
//
// Canvas Snake on a 30x30 grid (20 px tiles on the 600x600 #snp-game-canvas).
// The whole game state is saved to localStorage under 'snp-snake-state' after
// every tick, pause and timer second, and restored on load.
//
// A new game (page load, New Game, Restart, Play Again, Enter) and a restored
// save start paused behind the #snp-start-hint prompt (state.waiting) and begin
// on the first direction key, touch direction button, P or Pause/Resume. A save
// of a finished game is not resumed: it becomes a new game (best score and
// speed kept), so a reload never crashes straight into the same wall.
//
// Keys the game plays have their default action cancelled (snpHandleKeydown),
// so Enter never also clicks the button that kept the focus after a mouse
// click, and the arrows never scroll the page.
//
// The element lookups at the top run as soon as the script loads, as on the
// staging page, so tests/snake-game.test.js hands out stub elements through
// document.getElementById before it loads this file.

(function () {
    'use strict';

    var snpCanvas = document.getElementById('snp-game-canvas');
    var snpContext = snpCanvas.getContext('2d');

    var snpScoreElement = document.getElementById('snp-score');
    var snpBestScoreElement = document.getElementById('snp-best-score');
    var snpTimerElement = document.getElementById('snp-timer');

    var snpNewGameButton = document.getElementById('snp-new-game');
    var snpRestartButton = document.getElementById('snp-restart-game');
    var snpPauseButton = document.getElementById('snp-pause-game');

    var snpOverlay = document.getElementById('snp-overlay');
    var snpOverlayTitle = document.getElementById('snp-overlay-title');
    var snpOverlayText = document.getElementById('snp-overlay-text');
    var snpOverlayButton = document.getElementById('snp-overlay-button');
    var snpStartHint = document.getElementById('snp-start-hint');

    var snpToast = document.getElementById('snp-toast');
    var snpDifficulty = document.getElementById('snp-speed-select');

    var snpGridSize = 20;
    var snpTileCount = 30;

    var snpState = {
        snake: [],
        direction: { x: 1, y: 0 },
        nextDirection: { x: 1, y: 0 },
        food: { x: 10, y: 10 },
        score: 0,
        bestScore: 0,
        timer: 0,
        gameOver: false,
        paused: false,
        waiting: false,
        speed: 120,
        loop: null,
        timerLoop: null
    };

    function snpInit() {
        snpLoadState();

        if (!snpState.snake.length) {
            snpReset();
        }

        snpBindEvents();
        snpStartLoops();
        snpRender();
        snpUpdateUi();
    }

    function snpReset() {
        snpState.snake = [
            { x: 15, y: 15 },
            { x: 14, y: 15 },
            { x: 13, y: 15 }
        ];

        snpState.direction = { x: 1, y: 0 };
        snpState.nextDirection = { x: 1, y: 0 };
        snpState.score = 0;
        snpState.timer = 0;
        snpState.gameOver = false;
        snpState.speed = parseInt(snpDifficulty.value, 10);

        snpSpawnFood();
        snpHideOverlay();
        snpWaitForStart();
        snpUpdateUi();
        snpSaveState();
    }

    // Hold the game still (paused) behind the start prompt until the first
    // direction, P or the Pause/Resume button (see snpStartPlay).
    function snpWaitForStart() {
        snpState.paused = true;
        snpState.waiting = true;
        snpSetPauseLabel('Start');
        snpStartHint.classList.remove('snp-hidden');
    }

    function snpStartPlay() {
        snpState.paused = false;
        snpState.waiting = false;
        snpSetPauseLabel('Pause');
        snpStartHint.classList.add('snp-hidden');
        snpSaveState();
    }

    // The Pause/Resume button reads Start, Pause or Resume; its aria-label
    // ("Start game", "Pause game", "Resume game") follows the visible text.
    function snpSetPauseLabel(label) {
        snpPauseButton.textContent = label;
        snpPauseButton.setAttribute('aria-label', label + ' game');
    }

    function snpSpawnFood() {
        var valid = false;

        while (!valid) {
            snpState.food = {
                x: Math.floor(Math.random() * snpTileCount),
                y: Math.floor(Math.random() * snpTileCount)
            };

            valid = true;

            for (var i = 0; i < snpState.snake.length; i++) {
                if (
                    snpState.snake[i].x === snpState.food.x &&
                    snpState.snake[i].y === snpState.food.y
                ) {
                    valid = false;
                }
            }
        }
    }

    function snpGameTick() {
        if (snpState.gameOver || snpState.paused) {
            return;
        }

        snpState.direction = snpState.nextDirection;

        var head = {
            x: snpState.snake[0].x + snpState.direction.x,
            y: snpState.snake[0].y + snpState.direction.y
        };

        if (
            head.x < 0 ||
            head.y < 0 ||
            head.x >= snpTileCount ||
            head.y >= snpTileCount
        ) {
            snpHandleGameOver();
            return;
        }

        for (var i = 0; i < snpState.snake.length; i++) {
            if (
                snpState.snake[i].x === head.x &&
                snpState.snake[i].y === head.y
            ) {
                snpHandleGameOver();
                return;
            }
        }

        snpState.snake.unshift(head);

        if (head.x === snpState.food.x && head.y === snpState.food.y) {
            snpState.score += 10;

            if (snpState.score > snpState.bestScore) {
                snpState.bestScore = snpState.score;
            }

            snpShowToast('Energy node acquired +10');
            snpSpawnFood();
        } else {
            snpState.snake.pop();
        }

        if (snpState.snake.length >= 150) {
            snpShowVictory();
            return;
        }

        snpUpdateUi();
        snpSaveState();
        snpRender();
    }

    function snpRender() {
        snpContext.clearRect(0, 0, snpCanvas.width, snpCanvas.height);

        snpDrawGrid();
        snpDrawFood();
        snpDrawSnake();
    }

    function snpDrawGrid() {
        for (var x = 0; x < snpTileCount; x++) {
            for (var y = 0; y < snpTileCount; y++) {
                snpContext.fillStyle = (x + y) % 2 === 0
                    ? '#0f172a'
                    : '#111c34';

                snpContext.fillRect(
                    x * snpGridSize,
                    y * snpGridSize,
                    snpGridSize,
                    snpGridSize
                );
            }
        }
    }

    function snpDrawSnake() {
        for (var i = 0; i < snpState.snake.length; i++) {
            var segment = snpState.snake[i];

            snpContext.fillStyle = i === 0
                ? '#22d3ee'
                : '#3b82f6';

            snpContext.shadowColor = '#22d3ee';
            snpContext.shadowBlur = 12;

            snpContext.fillRect(
                segment.x * snpGridSize + 2,
                segment.y * snpGridSize + 2,
                snpGridSize - 4,
                snpGridSize - 4
            );
        }

        snpContext.shadowBlur = 0;
    }

    function snpDrawFood() {
        snpContext.fillStyle = '#f59e0b';
        snpContext.shadowColor = '#f59e0b';
        snpContext.shadowBlur = 18;

        snpContext.beginPath();
        snpContext.arc(
            snpState.food.x * snpGridSize + snpGridSize / 2,
            snpState.food.y * snpGridSize + snpGridSize / 2,
            8,
            0,
            Math.PI * 2
        );

        snpContext.fill();
        snpContext.shadowBlur = 0;
    }

    function snpBindEvents() {
        document.addEventListener('keydown', snpHandleKeydown);

        snpNewGameButton.addEventListener('click', snpHandleNewGame);
        snpRestartButton.addEventListener('click', snpHandleNewGame);
        snpPauseButton.addEventListener('click', snpTogglePause);
        snpOverlayButton.addEventListener('click', snpHandleNewGame);

        snpDifficulty.addEventListener('change', function () {
            snpState.speed = parseInt(snpDifficulty.value, 10);
            snpRestartLoops();
            snpSaveState();
        });

        document.getElementById('snp-up').addEventListener('click', function () {
            snpSetDirection(0, -1);
        });

        document.getElementById('snp-down').addEventListener('click', function () {
            snpSetDirection(0, 1);
        });

        document.getElementById('snp-left').addEventListener('click', function () {
            snpSetDirection(-1, 0);
        });

        document.getElementById('snp-right').addEventListener('click', function () {
            snpSetDirection(1, 0);
        });
    }

    // Editable fields on the host page (the WordPress search or comment box).
    // The game's own difficulty select is not one of them: after a mouse pick
    // it keeps the focus, and an arrow pressed next steers the snake instead
    // of also changing the difficulty.
    function snpIsOutsideField(target) {
        if (!target || target === snpDifficulty) {
            return false;
        }

        var tag = String(target.tagName || '').toUpperCase();

        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
    }

    // Physical keyboard. Shortcuts (Ctrl/Cmd/Alt + key) stay with the browser
    // and typing in a field on the host page stays with that field. A key the
    // game plays has its default action cancelled: otherwise Enter would also
    // click the Start/Pause button that kept the focus after a mouse click and
    // start the new game at once, into the wall, and the arrows would scroll
    // the page. Only lower-case WASD and P are read.
    function snpHandleKeydown(event) {
        // Chrome autofill fires keydown events that carry no key
        if (typeof event.key !== 'string') {
            return;
        }

        if (event.ctrlKey || event.metaKey || event.altKey || snpIsOutsideField(event.target)) {
            return;
        }

        switch (event.key) {
            case 'ArrowUp':
            case 'w':
                snpSetDirection(0, -1);
                break;
            case 'ArrowDown':
            case 's':
                snpSetDirection(0, 1);
                break;
            case 'ArrowLeft':
            case 'a':
                snpSetDirection(-1, 0);
                break;
            case 'ArrowRight':
            case 'd':
                snpSetDirection(1, 0);
                break;
            case 'p':
                snpTogglePause();
                break;
            case 'Enter':
                snpHandleNewGame();
                break;
            default:
                return;
        }

        event.preventDefault();
    }

    // Any direction starts a waiting game, even a reversal, which is still
    // refused (the snake keeps its heading).
    function snpSetDirection(x, y) {
        if (
            snpState.direction.x !== -x ||
            snpState.direction.y !== -y
        ) {
            snpState.nextDirection = { x: x, y: y };
        }

        if (snpState.waiting) {
            snpStartPlay();
        }
    }

    function snpHandleNewGame() {
        snpReset();
        snpRender();
    }

    function snpHandleGameOver() {
        snpState.gameOver = true;

        snpOverlayTitle.textContent = 'System Failure';
        snpOverlayText.textContent = 'Snake crashed into the cyber grid.';

        snpOverlay.classList.remove('snp-hidden');

        snpSaveState();
    }

    function snpShowVictory() {
        snpState.gameOver = true;

        snpOverlayTitle.textContent = 'Grid Dominated';
        snpOverlayText.textContent = 'You reached maximum snake length.';

        snpOverlay.classList.remove('snp-hidden');

        snpSaveState();
    }

    function snpHideOverlay() {
        snpOverlay.classList.add('snp-hidden');
    }

    function snpTogglePause() {
        if (snpState.gameOver) {
            return;
        }

        if (snpState.waiting) {
            snpStartPlay();
            return;
        }

        snpState.paused = !snpState.paused;

        snpSetPauseLabel(snpState.paused ? 'Resume' : 'Pause');

        snpShowToast(
            snpState.paused
                ? 'Simulation paused'
                : 'Simulation resumed'
        );

        snpSaveState();
    }

    function snpUpdateUi() {
        snpScoreElement.textContent = snpState.score;
        snpBestScoreElement.textContent = snpState.bestScore;
        snpTimerElement.textContent = snpFormatTime(snpState.timer);
    }

    function snpFormatTime(seconds) {
        var minutes = Math.floor(seconds / 60);
        var remainingSeconds = seconds % 60;

        return (
            String(minutes).padStart(2, '0') +
            ':' +
            String(remainingSeconds).padStart(2, '0')
        );
    }

    function snpShowToast(message) {
        snpToast.textContent = message;
        snpToast.classList.remove('snp-hidden');

        clearTimeout(snpToast.timeout);

        snpToast.timeout = setTimeout(function () {
            snpToast.classList.add('snp-hidden');
        }, 2200);
    }

    function snpStartLoops() {
        snpRestartLoops();

        clearInterval(snpState.timerLoop);

        snpState.timerLoop = setInterval(function () {
            if (!snpState.paused && !snpState.gameOver) {
                snpState.timer += 1;
                snpUpdateUi();
                snpSaveState();
            }
        }, 1000);
    }

    function snpRestartLoops() {
        clearInterval(snpState.loop);

        snpState.loop = setInterval(function () {
            requestAnimationFrame(snpGameTick);
        }, snpState.speed);
    }

    function snpSaveState() {
        localStorage.setItem('snp-snake-state', JSON.stringify(snpState));
    }

    function snpLoadState() {
        var saved = localStorage.getItem('snp-snake-state');

        if (!saved) {
            return;
        }

        try {
            var parsed = JSON.parse(saved);

            snpState.snake = parsed.snake || [];
            snpState.direction = parsed.direction || { x: 1, y: 0 };
            snpState.nextDirection = parsed.nextDirection || { x: 1, y: 0 };
            snpState.food = parsed.food || { x: 10, y: 10 };
            snpState.score = parsed.score || 0;
            snpState.bestScore = parsed.bestScore || 0;
            snpState.timer = parsed.timer || 0;
            snpState.speed = parsed.speed || 120;

            snpDifficulty.value = String(snpState.speed);

            if (parsed.gameOver) {
                // A lost (or won) game is not resumed into the same crash:
                // start a new one with the best score and speed kept.
                snpReset();
            } else {
                snpState.gameOver = false;
                snpWaitForStart();
            }
        } catch (error) {
            console.error(error);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', snpInit);
    } else if (typeof module === 'undefined' || !module.exports) {
        snpInit();
    }

    /* Node test export (no effect in browsers) */
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            snpState: snpState,
            snpTileCount: snpTileCount,
            snpInit: snpInit,
            snpFormatTime: snpFormatTime,
            snpReset: snpReset,
            snpSpawnFood: snpSpawnFood,
            snpGameTick: snpGameTick,
            snpSetDirection: snpSetDirection,
            snpHandleKeydown: snpHandleKeydown,
            snpTogglePause: snpTogglePause,
            snpSaveState: snpSaveState,
            snpLoadState: snpLoadState
        };
    }
})();
