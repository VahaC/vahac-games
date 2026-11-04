// Reaction Time Test — script.js
// Prefix: rxt-
// Dependencies: none.

(function () {
    'use strict';

    var rxtState = {
        status: 'idle',
        difficulty: 'normal',
        currentReaction: 0,
        bestReaction: null,
        attempts: 0,
        totalReaction: 0,
        sessionStart: null,
        signalTime: null,
        timeoutId: null,
        timerFrame: null,
        elapsed: 0
    };

    var rxtElements = {
        board: document.getElementById('rxt-board'),
        boardLabel: document.getElementById('rxt-board-label'),
        boardHint: document.getElementById('rxt-board-hint'),
        currentReaction: document.getElementById('rxt-current-reaction'),
        bestReaction: document.getElementById('rxt-best-reaction'),
        averageReaction: document.getElementById('rxt-average-reaction'),
        attempts: document.getElementById('rxt-attempts'),
        timer: document.getElementById('rxt-timer'),
        difficulty: document.getElementById('rxt-difficulty'),
        newGame: document.getElementById('rxt-new-game'),
        restartGame: document.getElementById('rxt-restart-game'),
        actionTrigger: document.getElementById('rxt-action-trigger'),
        toast: document.getElementById('rxt-toast'),
        overlay: document.getElementById('rxt-overlay'),
        overlayTitle: document.getElementById('rxt-overlay-title'),
        overlayText: document.getElementById('rxt-overlay-text'),
        overlayButton: document.getElementById('rxt-overlay-button'),
        statusPill: document.getElementById('rxt-status-pill')
    };

    function rxtGetDelay() {
        var rxtMap = {
            easy: [2000, 4500],
            normal: [1500, 3500],
            hard: [1000, 2500],
            extreme: [600, 1600]
        };

        var rxtRange = rxtMap[rxtState.difficulty];

        return Math.floor(
            Math.random() * (rxtRange[1] - rxtRange[0]) + rxtRange[0]
        );
    }

    function rxtSaveState() {
        localStorage.setItem(
            'rxt-reaction-state',
            JSON.stringify({
                difficulty: rxtState.difficulty,
                bestReaction: rxtState.bestReaction,
                attempts: rxtState.attempts,
                totalReaction: rxtState.totalReaction,
                elapsed: rxtState.elapsed
            })
        );
    }

    function rxtLoadState() {
        var rxtStored = localStorage.getItem('rxt-reaction-state');

        if (!rxtStored) {
            return;
        }

        try {
            var rxtParsed = JSON.parse(rxtStored);

            rxtState.difficulty = rxtParsed.difficulty || 'normal';
            rxtState.bestReaction = rxtParsed.bestReaction;
            rxtState.attempts = rxtParsed.attempts || 0;
            rxtState.totalReaction = rxtParsed.totalReaction || 0;
            rxtState.elapsed = rxtParsed.elapsed || 0;
        } catch (rxtError) {
            console.error(rxtError);
        }
    }

    function rxtShowToast(rxtMessage) {
        rxtElements.toast.textContent = rxtMessage;
        rxtElements.toast.classList.add('rxt-toast-visible');

        setTimeout(function () {
            rxtElements.toast.classList.remove('rxt-toast-visible');
        }, 2200);
    }

    function rxtUpdateStats() {
        rxtElements.currentReaction.textContent =
            rxtState.currentReaction + ' ms';

        rxtElements.bestReaction.textContent =
            rxtState.bestReaction !== null
                ? rxtState.bestReaction + ' ms'
                : '--';

        var rxtAverage = rxtState.attempts > 0
            ? Math.round(rxtState.totalReaction / rxtState.attempts)
            : 0;

        rxtElements.averageReaction.textContent = rxtAverage + ' ms';
        rxtElements.attempts.textContent = rxtState.attempts;
        rxtElements.timer.textContent = rxtState.elapsed.toFixed(1) + 's';

        rxtSaveState();
    }

    function rxtSetBoardState(rxtMode) {
        rxtElements.board.classList.remove(
            'rxt-board-idle',
            'rxt-board-waiting',
            'rxt-board-active',
            'rxt-board-failed'
        );

        rxtElements.board.classList.add('rxt-board-' + rxtMode);
    }

    function rxtStartTimer() {
        if (!rxtState.sessionStart) {
            rxtState.sessionStart = performance.now();
        }

        function rxtTick(rxtNow) {
            rxtState.elapsed = (rxtNow - rxtState.sessionStart) / 1000;
            rxtElements.timer.textContent = rxtState.elapsed.toFixed(1) + 's';
            rxtState.timerFrame = requestAnimationFrame(rxtTick);
        }

        cancelAnimationFrame(rxtState.timerFrame);
        rxtState.timerFrame = requestAnimationFrame(rxtTick);
    }

    function rxtStopTimer() {
        cancelAnimationFrame(rxtState.timerFrame);
    }

    function rxtStartRound() {
        clearTimeout(rxtState.timeoutId);

        rxtState.status = 'waiting';

        rxtSetBoardState('waiting');

        rxtElements.boardLabel.textContent = 'Wait...';
        rxtElements.boardHint.textContent =
            'Do NOT click until the neon signal appears.';

        rxtElements.statusPill.textContent = 'Waiting';

        var rxtDelay = rxtGetDelay();

        rxtState.timeoutId = setTimeout(function () {
            rxtActivateBoard();
        }, rxtDelay);
    }

    function rxtActivateBoard() {
        rxtState.status = 'active';
        rxtState.signalTime = performance.now();

        rxtSetBoardState('active');

        rxtElements.boardLabel.textContent = 'CLICK NOW';
        rxtElements.boardHint.textContent =
            'Tap, click, or press Space immediately.';

        rxtElements.statusPill.textContent = 'GO';
    }

    function rxtHandleSuccess() {
        var rxtReaction = Math.round(
            performance.now() - rxtState.signalTime
        );

        rxtState.currentReaction = rxtReaction;
        rxtState.attempts += 1;
        rxtState.totalReaction += rxtReaction;

        if (
            rxtState.bestReaction === null ||
            rxtReaction < rxtState.bestReaction
        ) {
            rxtState.bestReaction = rxtReaction;
            rxtShowToast('New best reaction time!');
        }

        rxtUpdateStats();

        rxtState.status = 'idle';

        rxtSetBoardState('idle');

        rxtElements.boardLabel.textContent = rxtReaction + ' ms';

        rxtElements.boardHint.textContent =
            'Excellent reflexes. Start another round.';

        rxtElements.statusPill.textContent = 'Completed';

        if (rxtState.attempts >= 10) {
            rxtShowOverlay();
        }
    }

    function rxtHandleFailure() {
        clearTimeout(rxtState.timeoutId);

        rxtState.status = 'idle';

        rxtSetBoardState('failed');

        rxtElements.boardLabel.textContent = 'Too Early';

        rxtElements.boardHint.textContent =
            'You reacted before the signal appeared.';

        rxtElements.statusPill.textContent = 'Fault';

        rxtShowToast('False start detected');
    }

    function rxtHandleBoardInteraction() {
        if (rxtState.status === 'waiting') {
            rxtHandleFailure();
            return;
        }

        if (rxtState.status === 'active') {
            rxtHandleSuccess();
        }
    }

    function rxtShowOverlay() {
        rxtStopTimer();

        var rxtAverage = Math.round(
            rxtState.totalReaction / rxtState.attempts
        );

        rxtElements.overlayTitle.textContent = 'Session Complete';

        rxtElements.overlayText.textContent =
            'Average reaction: ' +
            rxtAverage +
            ' ms | Best: ' +
            rxtState.bestReaction +
            ' ms';

        rxtElements.overlay.classList.add('rxt-overlay-visible');
    }

    function rxtResetGame() {
        clearTimeout(rxtState.timeoutId);
        rxtStopTimer();

        rxtState.status = 'idle';
        rxtState.currentReaction = 0;
        rxtState.attempts = 0;
        rxtState.totalReaction = 0;
        rxtState.elapsed = 0;
        rxtState.bestReaction = null;
        rxtState.sessionStart = performance.now();

        rxtUpdateStats();

        rxtSetBoardState('idle');

        rxtElements.boardLabel.textContent = 'Press Start';

        rxtElements.boardHint.textContent =
            'Wait for the neon signal, then react instantly.';

        rxtElements.statusPill.textContent = 'Ready';

        rxtStartTimer();
    }

    function rxtBindEvents() {
        rxtElements.newGame.addEventListener('click', function () {
            rxtResetGame();
            rxtStartRound();
        });

        rxtElements.restartGame.addEventListener('click', function () {
            rxtResetGame();
        });

        rxtElements.actionTrigger.addEventListener('click', function () {
            if (rxtState.status === 'idle') {
                rxtStartRound();
            }
        });

        rxtElements.board.addEventListener('click', rxtHandleBoardInteraction);

        rxtElements.board.addEventListener('touchstart', function () {
            rxtHandleBoardInteraction();
        });

        document.addEventListener('keydown', function (rxtEvent) {
            if (rxtEvent.code === 'Space') {
                rxtEvent.preventDefault();
                rxtHandleBoardInteraction();
            }

            if (rxtEvent.code === 'Enter') {
                if (rxtState.status === 'idle') {
                    rxtStartRound();
                }
            }
        });

        rxtElements.overlayButton.addEventListener('click', function () {
            rxtElements.overlay.classList.remove('rxt-overlay-visible');
            rxtResetGame();
        });

        rxtElements.difficulty.addEventListener('change', function () {
            rxtState.difficulty = rxtElements.difficulty.value;
            rxtSaveState();
            rxtShowToast('Difficulty updated');
        });
    }

    function rxtInit() {
        rxtLoadState();

        rxtElements.difficulty.value = rxtState.difficulty;

        rxtState.sessionStart = performance.now();

        rxtUpdateStats();
        rxtBindEvents();
        rxtStartTimer();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', rxtInit);
    } else if (typeof module === 'undefined' || !module.exports) {
        rxtInit();
    }

    /* Node test export (no effect in browsers) */
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            rxtState: rxtState,
            rxtGetDelay: rxtGetDelay,
            rxtSaveState: rxtSaveState,
            rxtLoadState: rxtLoadState,
            rxtUpdateStats: rxtUpdateStats,
            rxtStartRound: rxtStartRound,
            rxtActivateBoard: rxtActivateBoard,
            rxtHandleBoardInteraction: rxtHandleBoardInteraction,
            rxtResetGame: rxtResetGame,
            rxtInit: rxtInit
        };
    }
})();
