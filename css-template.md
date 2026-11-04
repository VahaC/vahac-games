# CSS Template Reference

This file contains the standard CSS variable palette and boilerplate selectors for new games.
Replace `{p}` with the chosen namespace prefix (e.g. `sdk`, `tf8`, `wrd`).

---

## Base palette (dark terminal theme)

```css
.{p}-wrapper {
  --{p}-bg-primary: #0a0f1e;
  --{p}-bg-secondary: #111827;
  --{p}-bg-card: #1a2236;
  --{p}-bg-input: #0d1424;
  --{p}-border: #2a3a5c;
  --{p}-border-focus: #3b82f6;
  --{p}-text-primary: #e2e8f0;
  --{p}-text-secondary: #94a3b8;
  --{p}-text-muted: #64748b;
  --{p}-accent-blue: #3b82f6;
  --{p}-accent-cyan: #22d3ee;
  --{p}-accent-green: #10b981;
  --{p}-accent-amber: #f59e0b;
  --{p}-accent-red: #ef4444;
  --{p}-font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', 'Consolas', monospace;
  --{p}-font-sans: 'Segoe UI', system-ui, -apple-system, sans-serif;
  --{p}-radius: 8px;

  font-family: var(--{p}-font-sans);
  color: var(--{p}-text-primary);
  line-height: 1.6;
  max-width: 860px;
  margin: 0 auto;
  padding: 2rem 1rem;
  box-sizing: border-box;
}

.{p}-wrapper *,
.{p}-wrapper *::before,
.{p}-wrapper *::after {
  box-sizing: border-box;
}
```

---

## Standard button classes

```css
.{p}-btn {
  padding: 0.65rem 1.5rem;
  background: var(--{p}-accent-blue);
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s, transform 0.1s;
  white-space: nowrap;
  font-family: inherit;
}

.{p}-btn:hover { background: #2563eb; }
.{p}-btn:active { transform: scale(0.97); }

.{p}-btn--secondary {
  background: transparent;
  border: 1px solid var(--{p}-border);
  color: var(--{p}-text-secondary);
}

.{p}-btn--secondary:hover {
  background: var(--{p}-bg-secondary);
  color: var(--{p}-text-primary);
}
```

---

## Standard toast notification

```css
.{p}-toast {
  position: fixed;
  bottom: 2rem;
  left: 50%;
  transform: translateX(-50%) translateY(100px);
  background: var(--{p}-accent-green);
  color: #fff;
  padding: 0.6rem 1.2rem;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 600;
  opacity: 0;
  transition: transform 0.3s, opacity 0.3s;
  z-index: 10000;
  pointer-events: none;
}

.{p}-toast.{p}-show {
  transform: translateX(-50%) translateY(0);
  opacity: 1;
}
```

---

## Standard error message

```css
.{p}-error-msg {
  color: var(--{p}-accent-red);
  font-size: 0.85rem;
  margin-top: 0.75rem;
  display: none;
}

.{p}-error-msg.{p}-visible {
  display: block;
}
```

---

## Standard input group

```css
.{p}-input-group label {
  display: block;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--{p}-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 0.4rem;
}

.{p}-input-group input,
.{p}-input-group select,
.{p}-input-group textarea {
  width: 100%;
  padding: 0.65rem 0.85rem;
  background: var(--{p}-bg-input);
  border: 1px solid var(--{p}-border);
  border-radius: 6px;
  color: var(--{p}-text-primary);
  font-family: var(--{p}-font-mono);
  font-size: 0.95rem;
  outline: none;
  transition: border-color 0.2s;
}

.{p}-input-group input:focus,
.{p}-input-group select:focus,
.{p}-input-group textarea:focus {
  border-color: var(--{p}-border-focus);
}

.{p}-input-group input::placeholder,
.{p}-input-group textarea::placeholder {
  color: var(--{p}-text-muted);
}
```

---

## Responsive breakpoint boilerplate

```css
@media (max-width: 640px) {
  .{p}-wrapper {
    padding: 1rem 0.75rem;
  }
  /* Stack flex rows into columns */
  .{p}-input-row {
    flex-direction: column;
  }
  .{p}-input-group {
    min-width: 100%;
  }
}
```

---

## JS IIFE boilerplate

```javascript
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function showError(msg) {
    var el = $('{p}-error-msg');
    el.textContent = msg;
    el.classList.add('{p}-visible');
  }

  function hideError() {
    $('{p}-error-msg').classList.remove('{p}-visible');
  }

  function showToast() {
    var toast = $('{p}-toast');
    toast.classList.add('{p}-show');
    setTimeout(function () { toast.classList.remove('{p}-show'); }, 2000);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(showToast).catch(fallback);
    } else {
      fallback();
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast();
    }
  }

  // ... game-specific logic ...

  // Expose to global scope for onclick handlers
  window.{p}Calculate = calculate;

  // Init on load
  // ...
})();
```

---

## Namespace prefix registry (existing games)

Keep this list updated to avoid prefix collisions. The prefix starts every CSS class, element id
and localStorage key of a game (`.{p}-wrapper`, `#{p}-board`, `{p}-state`).

| Prefix | Game               | Folder               | Status   |
|--------|--------------------|----------------------|----------|
| `msp`  | Minesweeper Game   | `minesweeper/`       | Built    |
| `rxt`  | Reaction Time Test | `reaction-time/`     | Built    |
| `sdk`  | Sudoku Game        | `sudoku/`            | Built    |
| `snp`  | Snake Game         | `snake-game/`        | Built    |
| `tf8`  | 2048 Game          | `2048-game/`         | Built    |
| `tst`  | Typing Speed Test  | `typing-speed-test/` | Built    |
| `wrd`  | Cyberpunk Wordle   | `wordle-game/`       | Built    |

## Prefixes already used by vahac-tools

Games and tools run on the same vahac.com origin and share one localStorage, so a new game must
not reuse a tool prefix either. These are the 39 prefixes in the vahac-tools registry (checked
against each tool folder's `.{p}-wrapper` in `style.css` on 2026-11-04):

`b64`, `brp`, `bsc`, `chm`, `cjs`, `crl`, `crn`, `csh`, `dcv`, `drc`, `egp`, `fvg`, `hav`, `hpc`, `hsg`, `icr`, `isc`, `jsf`, `jwt`, `lxi`, `mtx`, `ogm`, `pwg`, `rbt`, `rgx`, `sdr`, `sla`, `snc`, `tdf`, `tdl`, `ucb`, `urc`, `uts`, `vcg`, `wgc`, `wqr`, `yjt`, `zrc`, `zwc`

`hub` is used by the local index page (`index.html`) of both repositories. It is never embedded
on the site, but keep it out of games as well.

Pick a new prefix that is in neither list, and check the vahac-tools registry again before you
register it, since tools are added there independently. The game's folder name must not match a
vahac-tools folder name either (see Notes in `README.md`).
