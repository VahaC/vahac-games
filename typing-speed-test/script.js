// Typing Speed Test — script.js
// Prefix: tst-
// Dependencies: none.

(function () {
    'use strict';

    var tstTexts = {
        easy: [
            'Typing fast requires rhythm and consistency more than raw speed.',
            'Cyberpunk interfaces make keyboard training feel futuristic and immersive.'
        ],
        medium: [
            'Developers often improve productivity dramatically after mastering touch typing and keyboard shortcuts.',
            'Typing accuracy matters because excessive mistakes reduce effective words per minute performance.'
        ],
        hard: [
            'The futuristic terminal glowed intensely while holographic dashboards streamed complex diagnostics across the neon interface.',
            'Professional programmers frequently rely on mechanical keyboards, rapid command execution, and efficient typing habits.'
        ]
    };

    var tstState = {
        started: false,
        timer: 60,
        interval: null,
        text: '',
        difficulty: 'medium',
        bestWpm: 0
    };

    var tstElements = {
        input: document.getElementById('tst-input'),
        textDisplay: document.getElementById('tst-text-display'),
        wpm: document.getElementById('tst-wpm'),
        accuracy: document.getElementById('tst-accuracy'),
        timer: document.getElementById('tst-timer'),
        best: document.getElementById('tst-best'),
        result: document.getElementById('tst-result'),
        resultText: document.getElementById('tst-result-text'),
        difficulty: document.getElementById('tst-difficulty'),
        toast: document.getElementById('tst-toast')
    };

    function tstSaveState() {
        localStorage.setItem('tst-state', JSON.stringify({
            bestWpm: tstState.bestWpm,
            difficulty: tstState.difficulty
        }));
    }

    function tstLoadState() {
        var saved = localStorage.getItem('tst-state');

        if (!saved) {
            return;
        }

        var parsed = JSON.parse(saved);

        tstState.bestWpm = parsed.bestWpm || 0;
        tstState.difficulty = parsed.difficulty || 'medium';

        tstElements.best.textContent = tstState.bestWpm;
        tstElements.difficulty.value = tstState.difficulty;
    }

    function tstPickText() {
        var pool = tstTexts[tstState.difficulty];
        tstState.text = pool[Math.floor(Math.random() * pool.length)];
    }

    function tstRenderText(inputValue) {
        var html = '';

        tstState.text.split('').forEach(function (char, index) {
            var className = '';

            if (index < inputValue.length) {
                className = inputValue[index] === char
                    ? 'tst-char-correct'
                    : 'tst-char-wrong';
            } else if (index === inputValue.length) {
                className = 'tst-char-current';
            }

            html += '<span class="' + className + '">' + char + '</span>';
        });

        tstElements.textDisplay.innerHTML = html;
    }

    function tstCalculateStats() {
        var input = tstElements.input.value;
        var correct = 0;

        input.split('').forEach(function (char, index) {
            if (char === tstState.text[index]) {
                correct++;
            }
        });

        var accuracy = input.length
            ? Math.round((correct / input.length) * 100)
            : 100;

        var words = correct / 5;
        var minutes = (60 - tstState.timer) / 60 || 1 / 60;
        var wpm = Math.max(0, Math.round(words / minutes));

        tstElements.accuracy.textContent = accuracy + '%';
        tstElements.wpm.textContent = wpm;

        if (wpm > tstState.bestWpm) {
            tstState.bestWpm = wpm;
            tstElements.best.textContent = wpm;
            tstSaveState();
        }
    }

    function tstFinishGame() {
        clearInterval(tstState.interval);

        tstElements.result.classList.remove('tst-hidden');
        tstElements.resultText.textContent =
            'Final WPM: ' +
            tstElements.wpm.textContent +
            ' | Accuracy: ' +
            tstElements.accuracy.textContent;

        tstShowToast('Session completed');
    }

    function tstStartTimer() {
        tstState.interval = setInterval(function () {
            tstState.timer--;

            tstElements.timer.textContent = tstState.timer;

            if (tstState.timer <= 0) {
                tstFinishGame();
            }
        }, 1000);
    }

    function tstResetGame() {
        clearInterval(tstState.interval);

        tstState.started = false;
        tstState.timer = 60;
        tstState.difficulty = tstElements.difficulty.value;

        tstPickText();

        tstElements.input.value = '';
        tstElements.timer.textContent = '60';
        tstElements.wpm.textContent = '0';
        tstElements.accuracy.textContent = '100%';
        tstElements.result.classList.add('tst-hidden');

        tstRenderText('');

        tstSaveState();
    }

    function tstShowToast(message) {
        tstElements.toast.textContent = message;
        tstElements.toast.classList.remove('tst-hidden');

        setTimeout(function () {
            tstElements.toast.classList.add('tst-hidden');
        }, 2000);
    }

    function tstBindEvents() {
        document.getElementById('tst-new-game')
            .addEventListener('click', tstResetGame);

        document.getElementById('tst-restart-game')
            .addEventListener('click', tstResetGame);

        tstElements.difficulty.addEventListener('change', tstResetGame);

        tstElements.input.addEventListener('input', function () {
            if (!tstState.started) {
                tstState.started = true;
                tstStartTimer();
            }

            tstRenderText(tstElements.input.value);
            tstCalculateStats();

            if (tstElements.input.value === tstState.text) {
                tstFinishGame();
            }
        });
    }

    function tstInit() {
        tstLoadState();
        tstResetGame();
        tstBindEvents();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tstInit);
    } else if (typeof module === 'undefined' || !module.exports) {
        tstInit();
    }

    /* Node test export (no effect in browsers) */
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            tstTexts: tstTexts,
            tstState: tstState,
            tstElements: tstElements,
            tstSaveState: tstSaveState,
            tstLoadState: tstLoadState,
            tstPickText: tstPickText,
            tstRenderText: tstRenderText,
            tstCalculateStats: tstCalculateStats,
            tstFinishGame: tstFinishGame,
            tstStartTimer: tstStartTimer,
            tstResetGame: tstResetGame,
            tstShowToast: tstShowToast,
            tstBindEvents: tstBindEvents,
            tstInit: tstInit
        };
    }
})();
