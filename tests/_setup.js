// tests/_setup.js
// Minimal DOM / browser-global stubs so game script.js files can be require()'d
// in Node without throwing.  Copied from vahac-tools/tests/_setup.js and
// extended with what browser games touch: animation frames, timers, Web
// Storage, matchMedia, canvas, audio and vibration.
//
// A stub is installed only when Node lacks the global, so Node's own version
// always wins (Web Storage is the one exception, see below).  The element stubs
// keep a little state (classes, attributes, children) so a test can look at
// what a game built, but nothing here lays out or draws anything, the element
// stubs only understand simple selectors (see compileSelector), and no game
// loop runs by itself: animation frames only run when a test calls
// flushAnimationFrames() (or useClock's advance with frames).
//
// Contents (each helper is documented where it is defined):
//   Browser stubs      element (stubElement, with simple selectors for
//                      querySelector / matches / closest), document, window,
//                      storage (blockStorage makes it fail), timers and
//                      animation frames (useClock drives both with
//                      performance.now), matchMedia, canvas, audio, navigator.
//   Events             every element, document and window records its
//                      listeners and dispatchEvent runs them (capture, target,
//                      bubble; once, signal, duplicates ignored); el.click()
//                      clicks, el.focus() moves document.activeElement.
//                      makeEventTarget, createEvent, keyEvent, touchEvent,
//                      fire, pressKey, swipe, focusElement, typeInto,
//                      setVisibility, listenersOf, listenerCount.
//   Pages and loading  loadScript, createPage, loadWithPage, bootLikeBrowser,
//                      resetStubs (also undoes pages, boots, blocked storage
//                      and document / window listeners).
//   Randomness         seeded (a reproducible Math.random).
//   Source checks      REPO_ROOT, readRepoFile, idsInHtml, htmlPageSpec,
//                      embedMarkup, embedSafety, cssRules, declsAt.
// Everything here runs on Node 20.11+ (the Jenkins image is node:20-alpine).

'use strict';

var path = require('node:path');
var fs = require('node:fs');
var vm = require('node:vm');

// The repository root (the folder that holds package.json and the games).
var REPO_ROOT = path.resolve(__dirname, '..');

if (typeof globalThis.window === 'undefined') {
  globalThis.window = {};
}

function noop() {}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// classList: a DOMTokenList-like view over el.className, so the two stay in
// sync.  add/remove take several names, toggle(name, force) returns whether the
// name is present afterwards, replace(old, new) returns whether it replaced,
// contains/item/length read the current className.
function stubClassList(el) {
  function read() {
    return String(el.className || '').split(/\s+/).filter(Boolean);
  }
  function write(list) {
    el.className = list.join(' ');
  }
  var tokens = {
    add: function () {
      var list = read();
      for (var i = 0; i < arguments.length; i++) {
        var name = String(arguments[i]);
        if (list.indexOf(name) === -1) list.push(name);
      }
      write(list);
    },
    remove: function () {
      var drop = Array.prototype.map.call(arguments, String);
      write(read().filter(function (name) { return drop.indexOf(name) === -1; }));
    },
    toggle: function (name, force) {
      var has = tokens.contains(name);
      var want = force === undefined ? !has : !!force;
      if (want && !has) tokens.add(name);
      if (!want && has) tokens.remove(name);
      return want;
    },
    replace: function (oldName, newName) {
      var list = read();
      var i = list.indexOf(String(oldName));
      if (i === -1) return false;
      list[i] = String(newName);
      write(list.filter(function (name, j) { return list.indexOf(name) === j; }));
      return true;
    },
    contains: function (name) { return read().indexOf(String(name)) !== -1; },
    item: function (index) {
      var list = read();
      return index >= 0 && index < list.length ? list[index] : null;
    }
  };
  Object.defineProperty(tokens, 'length', {
    enumerable: true,
    get: function () { return read().length; }
  });
  return tokens;
}

// style: a plain object; assigned properties (style.gridTemplateColumns = ...)
// stay readable.  setProperty/getPropertyValue/removeProperty store under the
// exact name given (handy for CSS variables such as --tf8-size) and are
// non-enumerable, so Object.keys(el.style) lists only what was set.
function stubStyle() {
  var style = {};
  Object.defineProperties(style, {
    setProperty: {
      value: function (name, value) { style[name] = value == null ? '' : String(value); }
    },
    getPropertyValue: {
      value: function (name) { return hasOwn(style, name) ? style[name] : ''; }
    },
    removeProperty: {
      value: function (name) {
        var old = style.getPropertyValue(name);
        delete style[name];
        return old;
      }
    }
  });
  return style;
}

// ImageData-like result of getImageData/createImageData: a blank (all-zero)
// RGBA buffer of the requested size.
function stubImageData(width, height) {
  if (width && typeof width === 'object') {
    height = width.height;
    width = width.width;
  }
  var w = Math.abs(Math.floor(Number(width) || 0));
  var h = Math.abs(Math.floor(Number(height) || 0));
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}

// Canvas 2D context: every drawing method below is a no-op.  The state
// properties start at the browser defaults and keep whatever a game assigns.
// measureText reports width 0, getLineDash [], isPointInPath/Stroke false,
// gradients and patterns accept addColorStop/setTransform, and
// getImageData/createImageData return a blank buffer (stubImageData).
var CANVAS_2D_METHODS = [
  'arc', 'arcTo', 'beginPath', 'bezierCurveTo', 'clearRect', 'clip',
  'closePath', 'drawImage', 'ellipse', 'fill', 'fillRect', 'fillText',
  'lineTo', 'moveTo', 'putImageData', 'quadraticCurveTo', 'rect', 'reset',
  'resetTransform', 'restore', 'rotate', 'roundRect', 'save', 'scale',
  'setLineDash', 'setTransform', 'stroke', 'strokeRect', 'strokeText',
  'transform', 'translate'
];

function stubCanvasContext(canvas) {
  function gradient() { return { addColorStop: noop }; }
  var ctx = {
    canvas: canvas,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    lineDashOffset: 0,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    shadowBlur: 0,
    shadowColor: 'rgba(0, 0, 0, 0)',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    imageSmoothingEnabled: true,
    measureText: function () {
      return { width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 };
    },
    getLineDash: function () { return []; },
    isPointInPath: function () { return false; },
    isPointInStroke: function () { return false; },
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    createConicGradient: gradient,
    createPattern: function () { return { setTransform: noop }; },
    getImageData: function (sx, sy, sw, sh) { return stubImageData(sw, sh); },
    createImageData: function (width, height) { return stubImageData(width, height); }
  };
  CANVAS_2D_METHODS.forEach(function (name) { ctx[name] = noop; });
  return ctx;
}

// ── Events ──────────────────────────────────────────────────────────────────
//
// Every stub event target (elements, document, window and whatever a test
// passes to makeEventTarget) keeps its listeners in one registry, so a game's
// init() can be run as it is and its listeners driven afterwards.
//
// addEventListener(type, listener, options)
//   listener: a function (called with this = the current target) or an object
//   with handleEvent(event); null is ignored.  options: true / false (capture)
//   or { capture, once, passive, signal }.  The same type + listener + capture
//   is added once, as in browsers.  once removes the listener before it runs;
//   an AbortSignal removes it on abort (an already aborted one adds nothing).
//   passive is recorded (see listenersOf) but not enforced: preventDefault in a
//   passive listener still cancels.
// removeEventListener(type, listener, options): removes the listener with that
//   type and capture flag (unknown ones are ignored).  A listener removed while
//   an event is being dispatched does not run.
// dispatchEvent(event)
//   event: any object (createEvent builds one; a plain { type: 'click' } or a
//   native Event works too), a TypeError for anything else.  Missing pieces are
//   added: target (when null/undefined) is the node dispatched on,
//   preventDefault() sets defaultPrevented unless cancelable === false,
//   stopPropagation() and stopImmediatePropagation() work.  An event's own
//   methods are kept (a test's custom preventDefault() that sets another flag
//   leaves defaultPrevented alone).  currentTarget is the node whose listeners
//   are running, and null again afterwards.
//   Path: the target, then its parentNode chain; when that chain passes
//   document.body (or starts at document.documentElement) it goes on to
//   document and window (document itself goes on to window).  Detached
//   elements stop at their topmost ancestor, as in browsers.  Capture
//   listeners run from window down to the target's parent,
//   then at the target capture listeners before the others, then, only when
//   event.bubbles is true, the non-capture listeners up the path again.
//   stopPropagation ends the dispatch after the current node,
//   stopImmediatePropagation at once.  Listeners added during a dispatch wait
//   for the next one.  A listener that throws stops the dispatch and the error
//   reaches the test (browsers would only log it).
//   Returns !event.defaultPrevented.
// Element-only behaviour lives with stubElement (click, focus, blur).
// resetStubs() drops the listeners of document, window and document.body
// (element listeners go with their elements).
//
// Tests that replace el.addEventListener / document.addEventListener with
// their own recorder keep working: the registry simply never sees those
// listeners, so dispatchEvent / click() / fire / pressKey will not reach them.

var listenerRegistry = new WeakMap();   // target -> { type: [record] }
var activeDispatches = new WeakMap();   // event -> { stop, immediate }
var stubEventMethods = new WeakSet();   // methods createEvent/dispatch added

// Assign obj[key] = value, defining an own property where the object only has
// a getter (a native Event's target or currentTarget).
function setProp(obj, key, value) {
  try {
    obj[key] = value;
  } catch (e) {
    // getter-only property: assignment throws in strict mode
  }
  if (obj[key] !== value) {
    Object.defineProperty(obj, key, { value: value, writable: true, configurable: true, enumerable: true });
  }
}

function listenerOptions(options) {
  if (options && typeof options === 'object') {
    return {
      capture: !!options.capture,
      once: !!options.once,
      passive: !!options.passive,
      signal: options.signal || null
    };
  }
  return { capture: !!options, once: false, passive: false, signal: null };
}

function removeRecord(target, record) {
  record.removed = true;
  var byType = listenerRegistry.get(target);
  var list = byType && byType[record.type];
  if (!list) return;
  var at = list.indexOf(record);
  if (at !== -1) list.splice(at, 1);
}

function addListener(target, type, listener, options) {
  if (listener == null) return;
  var opts = listenerOptions(options);
  if (opts.signal && opts.signal.aborted) return;
  type = String(type);
  var byType = listenerRegistry.get(target);
  if (!byType) {
    byType = Object.create(null);
    listenerRegistry.set(target, byType);
  }
  var list = byType[type] || (byType[type] = []);
  for (var i = 0; i < list.length; i++) {
    if (list[i].listener === listener && list[i].capture === opts.capture) return;
  }
  var record = {
    type: type,
    listener: listener,
    capture: opts.capture,
    once: opts.once,
    passive: opts.passive,
    removed: false
  };
  list.push(record);
  if (opts.signal && typeof opts.signal.addEventListener === 'function') {
    opts.signal.addEventListener('abort', function () { removeRecord(target, record); }, { once: true });
  }
}

function removeListener(target, type, listener, options) {
  var byType = listenerRegistry.get(target);
  var list = byType && byType[String(type)];
  if (!list) return;
  var capture = listenerOptions(options).capture;
  for (var i = 0; i < list.length; i++) {
    if (list[i].listener === listener && list[i].capture === capture) {
      removeRecord(target, list[i]);
      return;
    }
  }
}

// preventDefault / defaultPrevented / stopPropagation /
// stopImmediatePropagation for an event that lacks them.
function addEventMethods(event) {
  if (typeof event.preventDefault !== 'function') {
    var preventDefault = function preventDefault() {
      if (event.cancelable !== false) setProp(event, 'defaultPrevented', true);
    };
    stubEventMethods.add(preventDefault);
    setProp(event, 'preventDefault', preventDefault);
  }
  if (event.defaultPrevented === undefined) setProp(event, 'defaultPrevented', false);
  if (typeof event.stopPropagation !== 'function') {
    var stopPropagation = function stopPropagation() {
      var state = activeDispatches.get(event);
      if (state) state.stop = true;
    };
    stubEventMethods.add(stopPropagation);
    setProp(event, 'stopPropagation', stopPropagation);
  }
  if (typeof event.stopImmediatePropagation !== 'function') {
    var stopImmediatePropagation = function stopImmediatePropagation() {
      var state = activeDispatches.get(event);
      if (state) {
        state.stop = true;
        state.immediate = true;
      }
    };
    stubEventMethods.add(stopImmediatePropagation);
    setProp(event, 'stopImmediatePropagation', stopImmediatePropagation);
  }
}

// An event's own stopPropagation / stopImmediatePropagation (native or from
// the test) still run, wrapped for one dispatch so the stub sees the call.
// Returns the function that puts the originals back.
function wrapOwnStopMethods(event, state) {
  var undo = [];
  ['stopPropagation', 'stopImmediatePropagation'].forEach(function (name) {
    var original = event[name];
    if (stubEventMethods.has(original)) return;
    var hadOwn = hasOwn(event, name);
    setProp(event, name, function () {
      state.stop = true;
      if (name === 'stopImmediatePropagation') state.immediate = true;
      return original.apply(event, arguments);
    });
    undo.push(function () {
      if (hadOwn) setProp(event, name, original);
      else delete event[name];
    });
  });
  return function () {
    undo.forEach(function (fn) { fn(); });
  };
}

function eventPath(target) {
  var win = globalThis.window;
  var doc = globalThis.document;
  var route = [target];
  if (target === win) return route;
  if (target !== doc) {
    var node = target;
    while (node && node.parentNode && route.indexOf(node.parentNode) === -1) {
      node = node.parentNode;
      route.push(node);
    }
    if (!doc || (route.indexOf(doc.body) === -1 && node !== doc.documentElement)) return route;
    route.push(doc);
  }
  if (win) route.push(win);
  return route;
}

// phase: 'capture' (capture listeners only), 'bubble' (the others) or
// 'target' (capture listeners first, then the others).
function invokeListeners(node, event, state, phase) {
  var byType = listenerRegistry.get(node);
  var list = byType && byType[String(event.type)];
  if (!list || !list.length) return;
  var snapshot = list.slice();
  var passes = phase === 'target' ? [true, false] : [phase === 'capture'];
  setProp(event, 'currentTarget', node);
  for (var p = 0; p < passes.length; p++) {
    for (var i = 0; i < snapshot.length; i++) {
      if (state.immediate) return;
      var record = snapshot[i];
      if (record.removed || record.capture !== passes[p]) continue;
      if (record.once) removeRecord(node, record);
      if (typeof record.listener === 'function') {
        record.listener.call(node, event);
      } else if (record.listener && typeof record.listener.handleEvent === 'function') {
        record.listener.handleEvent(event);
      }
    }
  }
}

function dispatchStubEvent(target, event) {
  if (!event || typeof event !== 'object') {
    throw new TypeError('dispatchEvent: parameter 1 is not an event object');
  }
  addEventMethods(event);
  if (event.target == null) setProp(event, 'target', target);
  var state = { stop: false, immediate: false };
  var outer = activeDispatches.get(event);
  activeDispatches.set(event, state);
  var restoreMethods = wrapOwnStopMethods(event, state);
  try {
    var route = eventPath(target);
    var i;
    for (i = route.length - 1; i > 0 && !state.stop; i--) invokeListeners(route[i], event, state, 'capture');
    if (!state.stop) invokeListeners(target, event, state, 'target');
    if (event.bubbles) {
      for (i = 1; i < route.length && !state.stop; i++) invokeListeners(route[i], event, state, 'bubble');
    }
  } finally {
    restoreMethods();
    if (outer) activeDispatches.set(event, outer);
    else activeDispatches.delete(event);
    setProp(event, 'currentTarget', null);
  }
  return !event.defaultPrevented;
}

// makeEventTarget(obj): gives obj working addEventListener /
// removeEventListener / dispatchEvent (replacing any it has) and returns it.
// The methods are bound to obj, so a detached `var on = el.addEventListener`
// still works.  Example: a matchMedia result whose 'change' a test fires.
function eventTargetMethods(target) {
  return {
    addEventListener: function addEventListener(type, listener, options) {
      addListener(target, type, listener, options);
    },
    removeEventListener: function removeEventListener(type, listener, options) {
      removeListener(target, type, listener, options);
    },
    dispatchEvent: function dispatchEvent(event) {
      return dispatchStubEvent(target, event);
    }
  };
}

function makeEventTarget(obj) {
  var methods = eventTargetMethods(obj);
  obj.addEventListener = methods.addEventListener;
  obj.removeEventListener = methods.removeEventListener;
  obj.dispatchEvent = methods.dispatchEvent;
  return obj;
}

// listenersOf(target, type): the listeners the registry holds for target, in
// the order they run within a phase, as { type, listener, capture, once,
// passive } copies; all types when type is omitted.  listenerCount(target,
// type) is their number.  Use them to check that init() registered what it
// should and that a new game does not stack a second copy of a listener.
function listenersOf(target, type) {
  var byType = listenerRegistry.get(target);
  if (!byType) return [];
  var types = type === undefined ? Object.keys(byType) : [String(type)];
  var out = [];
  types.forEach(function (t) {
    (byType[t] || []).forEach(function (r) {
      out.push({ type: r.type, listener: r.listener, capture: r.capture, once: r.once, passive: r.passive });
    });
  });
  return out;
}

function listenerCount(target, type) {
  return listenersOf(target, type).length;
}

// The registry's own records for a target, every type (internal).
function registryRecords(target) {
  var byType = target && listenerRegistry.get(target);
  if (!byType) return [];
  var out = [];
  Object.keys(byType).forEach(function (type) { out.push.apply(out, byType[type]); });
  return out;
}

// Event types that bubble, and those that cannot be cancelled, by default.
var BUBBLING_EVENTS = [
  'click', 'dblclick', 'auxclick', 'contextmenu', 'mousedown', 'mouseup', 'mousemove',
  'mouseover', 'mouseout', 'pointerdown', 'pointerup', 'pointermove', 'pointerover',
  'pointerout', 'pointercancel', 'touchstart', 'touchmove', 'touchend', 'touchcancel',
  'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'change', 'submit', 'reset',
  'select', 'wheel', 'focusin', 'focusout', 'copy', 'cut', 'paste', 'compositionstart',
  'compositionupdate', 'compositionend', 'dragstart', 'drag', 'dragenter', 'dragleave',
  'dragover', 'drop', 'dragend', 'DOMContentLoaded', 'visibilitychange'
];
var UNCANCELABLE_EVENTS = [
  'input', 'change', 'focus', 'blur', 'focusin', 'focusout', 'load', 'unload', 'resize',
  'scroll', 'DOMContentLoaded', 'mouseenter', 'mouseleave', 'pointerenter',
  'pointerleave', 'pointercancel', 'touchcancel', 'select', 'compositionend',
  'visibilitychange', 'transitionend', 'animationend'
];

// createEvent(type, props): a plain event object for dispatchEvent or for
// calling a handler directly: { type, bubbles, cancelable, defaultPrevented:
// false, isTrusted: false, target: null, currentTarget: null } with working
// preventDefault / stopPropagation / stopImmediatePropagation, then every
// property of props copied on top (props win, so { bubbles: false } or a
// target can be forced).  bubbles and cancelable follow the browser for the
// type: click, key, input, change, touch, pointer and mouse events and
// visibilitychange bubble; input, change, focus, blur, load, resize, scroll
// ... cannot be cancelled.
// No timeStamp is added (it would call a mocked performance.now).
//   createEvent('click', { clientX: 10 })
function createEvent(type, props) {
  type = String(type);
  var event = {
    type: type,
    bubbles: BUBBLING_EVENTS.indexOf(type) !== -1,
    cancelable: UNCANCELABLE_EVENTS.indexOf(type) === -1,
    defaultPrevented: false,
    isTrusted: false,
    target: null,
    currentTarget: null
  };
  addEventMethods(event);
  if (props) {
    Object.keys(props).forEach(function (key) { event[key] = props[key]; });
  }
  return event;
}

var NAMED_KEYS = {
  Enter: 13, Escape: 27, Backspace: 8, Tab: 9, Delete: 46, Insert: 45,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34
};
var MODIFIER_KEYS = { Shift: 16, Control: 17, Alt: 18, Meta: 91 };
var PUNCTUATION_KEYS = {
  '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219],
  ']': ['BracketRight', 221], ';': ['Semicolon', 186], '\'': ['Quote', 222],
  ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191],
  '\\': ['Backslash', 220], '`': ['Backquote', 192]
};

// The US-layout KeyboardEvent.code and legacy keyCode for a key value.
function keyInfo(key) {
  if (typeof key !== 'string') return { code: '', keyCode: 0 };
  if (/^[a-zA-Z]$/.test(key)) return { code: 'Key' + key.toUpperCase(), keyCode: key.toUpperCase().charCodeAt(0) };
  if (/^[0-9]$/.test(key)) return { code: 'Digit' + key, keyCode: 48 + Number(key) };
  if (key === ' ') return { code: 'Space', keyCode: 32 };
  if (hasOwn(NAMED_KEYS, key)) return { code: key, keyCode: NAMED_KEYS[key] };
  if (hasOwn(MODIFIER_KEYS, key)) return { code: key + 'Left', keyCode: MODIFIER_KEYS[key] };
  if (/^F([1-9]|1[0-2])$/.test(key)) return { code: key, keyCode: 111 + Number(key.slice(1)) };
  if (hasOwn(PUNCTUATION_KEYS, key)) return { code: PUNCTUATION_KEYS[key][0], keyCode: PUNCTUATION_KEYS[key][1] };
  return { code: '', keyCode: 0 };
}

// keyEvent(key, props): a keydown createEvent with key, the matching code
// ('a' -> 'KeyA', '7' -> 'Digit7', ' ' -> 'Space', 'ArrowLeft' -> 'ArrowLeft',
// 'Shift' -> 'ShiftLeft', '' for unknown keys), keyCode / which, location 0,
// repeat and isComposing false and ctrlKey / metaKey / altKey / shiftKey
// false.  Nothing is inferred from capitals: keyEvent('A') has shiftKey false
// unless props say so.  props override anything, { type: 'keyup' } included.
// keyEvent(undefined) has no key, like Chrome's autofill keydown.
//   document.dispatchEvent(keyEvent('ArrowLeft'))
//   keyEvent('z', { ctrlKey: true, target: input })
function keyEvent(key, props) {
  var info = keyInfo(key);
  var base = {
    key: key == null ? key : String(key),
    code: info.code,
    keyCode: info.keyCode,
    which: info.keyCode,
    location: 0,
    repeat: false,
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false
  };
  return createEvent((props && props.type) || 'keydown', Object.assign(base, props));
}

// touchEvent(type, points, props): a touchstart / touchmove / touchend /
// touchcancel createEvent.  points is one point or an array of them; a point
// is [x, y] or an object with clientX / clientY (and any other Touch fields).
// Each becomes { identifier, target: null, clientX, clientY, pageX, pageY,
// screenX, screenY }.  touches and targetTouches hold the points for start and
// move and are empty for end and cancel; changedTouches always holds them.
//   board.dispatchEvent(touchEvent('touchstart', [100, 200]))
//   touchEvent('touchend', { clientX: 160, clientY: 200 })
function touchEvent(type, points, props) {
  var list;
  if (points == null) list = [];
  else if (Array.isArray(points) && typeof points[0] !== 'number') list = points;
  else list = [points];
  var touches = list.map(function (point, i) {
    var p = Array.isArray(point) ? { clientX: point[0], clientY: point[1] } : point;
    return Object.assign({
      identifier: i,
      target: null,
      clientX: p.clientX,
      clientY: p.clientY,
      pageX: p.clientX,
      pageY: p.clientY,
      screenX: p.clientX,
      screenY: p.clientY
    }, p);
  });
  var ending = type === 'touchend' || type === 'touchcancel';
  return createEvent(type, Object.assign({
    touches: ending ? [] : touches,
    targetTouches: ending ? [] : touches,
    changedTouches: touches,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false
  }, props));
}

// fire(target, type, props): target.dispatchEvent(createEvent(type, props));
// returns the event, so a test can look at defaultPrevented.
//   fire(els['snp-speed-select'], 'change')
function fire(target, type, props) {
  var event = createEvent(type, props);
  target.dispatchEvent(event);
  return event;
}

// pressKey(key, props): a key pressed on the page.  The keydown (keyEvent(key,
// props)) is dispatched on props.target, else document.activeElement, else
// document.body, so it bubbles to the document and window listeners when that
// element is in the page (createPage elements are; see eventPath above).
// Then, unless a listener called preventDefault, the browser's default action
// for Enter or Space on a focused, enabled BUTTON runs: button.click().  (A
// real browser clicks on Space at keyup; nothing else is emulated.)  Returns
// the keydown event.
//   const ev = pressKey('ArrowUp'); assert.equal(ev.defaultPrevented, true);
//   pressKey('Enter', { target: els['wrd-new-game'] })
function pressKey(key, props) {
  var doc = globalThis.document;
  var event = keyEvent(key, props);
  var target = event.target || doc.activeElement || doc.body;
  target.dispatchEvent(event);
  var onButton = target && target.tagName === 'BUTTON' && !target.disabled && typeof target.click === 'function';
  if (event.type === 'keydown' && !event.defaultPrevented && onButton && (event.key === 'Enter' || event.key === ' ')) {
    target.click();
  }
  return event;
}

// swipe(target, from, to, props): a one-finger swipe on target: touchstart at
// from, touchmove at to, touchend with changedTouches at to (points as in
// touchEvent; props go on all three).  Returns { start, move, end }.
//   swipe(els['tf8-board'], [100, 100], [200, 110])   // a swipe right
function swipe(target, from, to, props) {
  var start = touchEvent('touchstart', from, props);
  target.dispatchEvent(start);
  var move = touchEvent('touchmove', to, props);
  target.dispatchEvent(move);
  var end = touchEvent('touchend', to, props);
  target.dispatchEvent(end);
  return { start: start, move: move, end: end };
}

// focusElement(el, options): the focus moving to el the way a browser moves
// it: blur and focusout on the element that had it (unless that was
// document.body; document.activeElement is body meanwhile), then
// document.activeElement = el, focus and focusin on el.  relatedTarget is the
// other element (null for body).  options.keyboard true means the focus came
// from the keyboard (Tab, Shift+Tab), so el matches :focus-visible until it
// loses the focus; false or omitted is a mouse click or a tap.  Nothing
// happens for a disabled el or one that already has the focus.  Returns
// whether the focus moved.
//   focusElement(els['wrd-new-game'], { keyboard: true }); // Tab to the button
function focusElement(el, options) {
  var doc = globalThis.document;
  if (!el || el.disabled || doc.activeElement === el) return false;
  var old = doc.activeElement;
  var from = old && old !== doc.body ? old : null;
  if (from) {
    doc.activeElement = doc.body;
    from.dispatchEvent(createEvent('blur', { relatedTarget: el }));
    from.dispatchEvent(createEvent('focusout', { relatedTarget: el }));
  }
  doc.activeElement = el;
  if (options && options.keyboard) focusVisible.add(el);
  else focusVisible.delete(el);
  el.dispatchEvent(createEvent('focus', { relatedTarget: from }));
  el.dispatchEvent(createEvent('focusin', { relatedTarget: from }));
  return true;
}

// typeInto(input, value, props): what typing into a field does.  A disabled
// or readOnly field throws (nobody can type there, so a test that tries has a
// bug); otherwise input.value becomes value (a string) and a bubbling 'input'
// event fires with inputType 'insertText' and data = value, or with
// inputType 'deleteContentBackward' and data null when value is empty (props
// win).  Returns the event.
//   typeInto(cells[4], '7');
function typeInto(input, value, props) {
  if (!input || typeof input !== 'object') throw new TypeError('typeInto: parameter 1 is not an element');
  var name = input.id ? '#' + input.id : String(input.tagName || 'the element');
  if (input.disabled) throw new Error('typeInto: ' + name + ' is disabled, so nobody can type in it');
  if (input.readOnly) throw new Error('typeInto: ' + name + ' is read-only, so nobody can type in it');
  input.value = value == null ? '' : String(value);
  return fire(input, 'input', Object.assign({
    inputType: input.value ? 'insertText' : 'deleteContentBackward',
    data: input.value ? input.value : null,
    isComposing: false
  }, props));
}

// setVisibility(state, t): the tab is hidden ('hidden') or shown again
// ('visible'): document.visibilityState = state and document.hidden follows,
// then a visibilitychange event fires on document (it bubbles to window, as in
// browsers) and is returned.  With t (a test context) the defaults come back
// after that test; resetStubs() puts them back too.
//   setVisibility('hidden', t);
function setVisibility(state, t) {
  var doc = globalThis.document;
  doc.visibilityState = String(state);
  doc.hidden = doc.visibilityState === 'hidden';
  if (t && typeof t.after === 'function') {
    t.after(function () {
      doc.visibilityState = documentDefaults.visibilityState;
      doc.hidden = documentDefaults.hidden;
    });
  }
  return fire(doc, 'visibilitychange');
}

// Element stub.  stubElement(tagName) defaults to a DIV; a CANVAS starts at
// 300x150 like the browser default.
//   - classList: see stubClassList; style: see stubStyle; dataset: plain object.
//   - setAttribute/getAttribute/hasAttribute/removeAttribute keep a private
//     attribute map (names lower-cased); id, class and data-* are mirrored onto
//     el.id, el.className and el.dataset.  getAttribute returns null for an
//     attribute that was never set.
//   - appendChild/insertBefore/removeChild/remove keep children, childNodes,
//     firstChild/lastChild and parentElement/parentNode up to date (appending a
//     child moves it out of its old parent).  Text nodes (document.
//     createTextNode) go into childNodes only, as in browsers; children holds
//     the rest.  removeChild of a non-child is ignored rather than throwing.
//     contains(node) walks the tracked children.  Taking the focused element
//     (or an ancestor of it) out of its parent, by removeChild, remove(), a
//     move to another parent or innerHTML / textContent, puts the focus back
//     on document.body, as browsers do, so a game that rebuilds the focused
//     control loses the focus in tests too.
//   - innerHTML/textContent: setting either drops the tracked children, as
//     replacing an element's content does.  innerHTML is not parsed: it reads
//     back what was assigned (or the escaped text after a textContent
//     assignment), and assigning it sets the element's own text to the markup
//     with its tags removed.  textContent reads the element's own text followed
//     by the textContent of each child node, like a browser's concatenation of
//     descendant text.
//   - querySelector / querySelectorAll search the element's descendants,
//     matches tests the element and closest walks up from it, all with the
//     compound selectors of compileSelector (tag, #id, .class, [attr=value],
//     :focus, :focus-visible, :disabled ...).  A selector it cannot read
//     (combinators, other pseudo-classes) gives null, [] and false, as the
//     stubs always did.
//   - addEventListener/removeEventListener/dispatchEvent work (see Events).
//   - click() dispatches a bubbling, cancelable click ({ button: 0, detail: 1 })
//     unless el.disabled is set; no default action runs (a checkbox does not
//     toggle).
//   - focus() makes the element document.activeElement (not when disabled);
//     blur() puts the focus back on document.body if the element had it.
//     Neither fires focus/blur events, and neither counts as keyboard focus
//     for :focus-visible (focusElement does both).  select and scrollIntoView
//     are no-ops.
//   - getBoundingClientRect returns a rect at (0, 0) sized by el.width/el.height
//     (300x150 for a canvas, 0x0 otherwise); offset*/client* sizes are 0.
//   - getContext('2d') returns one context per element (see stubCanvasContext);
//     any other context type returns null.  toDataURL returns 'data:,'.
//   - cloneNode returns a fresh stub with the same tag name.

// Elements whose last focus came from the keyboard (focusElement with
// keyboard: true).  :focus-visible matches one of them while it still has the
// focus; focusing it again any other way removes the mark.
var focusVisible = new WeakSet();

// node left the document tree: if it is or holds the focused element, the
// focus goes back to document.body.
function dropFocusFrom(node) {
  var doc = globalThis.document;
  if (!doc || typeof doc !== 'object') return;
  var active = doc.activeElement;
  if (!active || active === doc.body) return;
  if (node === active || (typeof node.contains === 'function' && node.contains(active))) {
    doc.activeElement = doc.body || null;
  }
}

function stubElement(tagName) {
  var tag = String(tagName || 'div').toUpperCase();
  var attributes = {};
  var html = '';
  var text = '';
  var context2d = null;

  function detach(node) {
    var parent = node && node.parentNode;
    if (parent && typeof parent.removeChild === 'function') parent.removeChild(node);
  }

  function datasetKey(name) {
    return name.slice(5).replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
  }

  function clearChildren() {
    el.childNodes.forEach(function (child) {
      if (child && typeof child === 'object') {
        child.parentElement = null;
        child.parentNode = null;
        dropFocusFrom(child);
      }
    });
    el.children.length = 0;
    el.childNodes.length = 0;
  }

  // children: the childNodes that are not text (or comment) nodes, kept in
  // the same array object.
  function syncChildren() {
    el.children.length = 0;
    el.childNodes.forEach(function (node) {
      if (!node || (node.nodeType !== 3 && node.nodeType !== 8)) el.children.push(node);
    });
  }

  var el = {
    tagName: tag,
    nodeName: tag,
    nodeType: 1,
    id: '',
    value: '',
    className: '',
    checked: false,
    disabled: false,
    hidden: false,
    style: stubStyle(),
    dataset: {},
    children: [],
    childNodes: [],
    parentElement: null,
    parentNode: null,
    offsetWidth: 0,
    offsetHeight: 0,
    clientWidth: 0,
    clientHeight: 0,
    scrollTop: 0,
    scrollLeft: 0,
    appendChild: function (child) {
      detach(child);
      el.childNodes.push(child);
      syncChildren();
      child.parentElement = el;
      child.parentNode = el;
      return child;
    },
    insertBefore: function (child, ref) {
      detach(child);
      var at = ref == null ? -1 : el.childNodes.indexOf(ref);
      if (at === -1) el.childNodes.push(child);
      else el.childNodes.splice(at, 0, child);
      syncChildren();
      child.parentElement = el;
      child.parentNode = el;
      return child;
    },
    removeChild: function (child) {
      var at = el.childNodes.indexOf(child);
      if (at !== -1) {
        el.childNodes.splice(at, 1);
        syncChildren();
        child.parentElement = null;
        child.parentNode = null;
        dropFocusFrom(child);
      }
      return child;
    },
    remove: function () { detach(el); },
    contains: function (node) {
      if (node === el) return true;
      return el.childNodes.some(function (child) {
        return child && typeof child.contains === 'function' && child.contains(node);
      });
    },
    setAttribute: function (name, value) {
      name = String(name).toLowerCase();
      value = String(value);
      attributes[name] = value;
      if (name === 'id') el.id = value;
      else if (name === 'class') el.className = value;
      else if (name.indexOf('data-') === 0) el.dataset[datasetKey(name)] = value;
    },
    getAttribute: function (name) {
      name = String(name).toLowerCase();
      if (name === 'id' && el.id) return el.id;
      if (name === 'class' && el.className) return el.className;
      return hasOwn(attributes, name) ? attributes[name] : null;
    },
    hasAttribute: function (name) { return el.getAttribute(name) !== null; },
    removeAttribute: function (name) {
      name = String(name).toLowerCase();
      delete attributes[name];
      if (name === 'id') el.id = '';
      else if (name === 'class') el.className = '';
      else if (name.indexOf('data-') === 0) delete el.dataset[datasetKey(name)];
    },
    querySelector: function (selector) {
      var matches = compileSelector(selector);
      return matches ? pageElements(el).filter(matches)[0] || null : null;
    },
    querySelectorAll: function (selector) {
      var matches = compileSelector(selector);
      return matches ? pageElements(el).filter(matches) : [];
    },
    closest: function (selector) {
      var matches = compileSelector(selector);
      for (var node = el; matches && node && node.nodeType === 1; node = node.parentNode) {
        if (matches(node)) return node;
      }
      return null;
    },
    matches: function (selector) {
      var matches = compileSelector(selector);
      return matches ? matches(el) : false;
    },
    focus: function () {
      var doc = globalThis.document;
      if (el.disabled || !doc || typeof doc !== 'object') return;
      if (doc.activeElement !== el) focusVisible.delete(el);
      doc.activeElement = el;
    },
    blur: function () {
      var doc = globalThis.document;
      if (doc && doc.activeElement === el) doc.activeElement = doc.body || null;
    },
    select: noop,
    click: function () {
      if (!el.disabled) el.dispatchEvent(createEvent('click', { button: 0, detail: 1 }));
    },
    scrollIntoView: noop,
    getBoundingClientRect: function () {
      var width = Number(el.width) || 0;
      var height = Number(el.height) || 0;
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width: width, height: height };
    },
    getContext: function (type) {
      if (String(type) !== '2d') return null;
      if (!context2d) context2d = stubCanvasContext(el);
      return context2d;
    },
    toDataURL: function () { return 'data:,'; },
    cloneNode: function () { return stubElement(tag); }
  };

  if (tag === 'CANVAS') {
    el.width = 300;
    el.height = 150;
  }

  el.classList = stubClassList(el);
  makeEventTarget(el);

  Object.defineProperties(el, {
    innerHTML: {
      enumerable: true,
      get: function () { return html; },
      set: function (value) {
        html = value == null ? '' : String(value);
        text = decodeEntities(html.replace(/<[^>]*>/g, ''));
        clearChildren();
      }
    },
    textContent: {
      enumerable: true,
      get: function () {
        return text + el.childNodes.map(function (node) {
          return node && node.nodeType !== 8 && node.textContent != null ? String(node.textContent) : '';
        }).join('');
      },
      set: function (value) {
        text = value == null ? '' : String(value);
        html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        clearChildren();
      }
    },
    firstChild: {
      enumerable: true,
      get: function () { return el.childNodes.length ? el.childNodes[0] : null; }
    },
    lastChild: {
      enumerable: true,
      get: function () { return el.childNodes.length ? el.childNodes[el.childNodes.length - 1] : null; }
    }
  });

  return el;
}

// Text node stub (document.createTextNode): nodeType 3, nodeName '#text', and
// data / nodeValue / textContent as one string; parentNode / parentElement
// follow appendChild, remove() detaches it.
function stubTextNode(value) {
  var data = value == null ? '' : String(value);
  var node = {
    nodeType: 3,
    nodeName: '#text',
    parentNode: null,
    parentElement: null,
    remove: function () {
      if (node.parentNode && typeof node.parentNode.removeChild === 'function') node.parentNode.removeChild(node);
    },
    cloneNode: function () { return stubTextNode(data); }
  };
  ['data', 'nodeValue', 'textContent'].forEach(function (name) {
    Object.defineProperty(node, name, {
      enumerable: true,
      get: function () { return data; },
      set: function (v) { data = v == null ? '' : String(v); }
    });
  });
  return node;
}

// document: readyState 'complete' (so a game's start-up guard skips the
// DOMContentLoaded wait), documentElement (an HTML stub) holding a BODY stub,
// visibilityState 'visible' and hidden false (setVisibility changes them),
// activeElement (document.body until an element's focus() or a test changes
// it), getElementById null, querySelector null and querySelectorAll []
// (createPage installs real id lookups), createElement -> stubElement,
// createTextNode -> stubTextNode, execCommand true, and the event target
// methods (see Events).  resetStubs puts documentElement, visibilityState,
// hidden and activeElement back.
var documentDefaults = {
  documentElement: stubElement('html'),
  visibilityState: 'visible',
  hidden: false
};

if (typeof globalThis.document === 'undefined') {
  globalThis.document = makeEventTarget({
    readyState: 'complete',
    documentElement: documentDefaults.documentElement,
    body: documentDefaults.documentElement.appendChild(stubElement('body')),
    visibilityState: documentDefaults.visibilityState,
    hidden: documentDefaults.hidden,
    activeElement: null,
    getElementById: function () { return null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    createElement: function (tagName) { return stubElement(tagName); },
    createTextNode: function (value) { return stubTextNode(value); },
    execCommand: function () { return true; }
  });
  globalThis.document.activeElement = globalThis.document.body;
}

if (typeof globalThis.location === 'undefined') {
  globalThis.location = {
    hash: '',
    pathname: '/',
    search: '',
    href: 'http://localhost/'
  };
}

if (typeof globalThis.history === 'undefined') {
  globalThis.history = { replaceState: noop, pushState: noop };
}

if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = {
    clipboard: { writeText: function () { return Promise.resolve(); } }
  };
}

// Node 21+ has its own global navigator, which lacks clipboard and vibrate, so
// add them to whichever navigator exists.
//   navigator.clipboard.writeText: resolves at once.
//   navigator.vibrate(pattern): accepts any pattern and returns true, like a
//   phone that vibrates.
if (typeof globalThis.navigator.clipboard === 'undefined') {
  globalThis.navigator.clipboard = { writeText: function () { return Promise.resolve(); } };
}

if (typeof globalThis.navigator.vibrate !== 'function') {
  globalThis.navigator.vibrate = function () { return true; };
}

if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = require('node:crypto').webcrypto;
}

if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = require('node:util').TextEncoder;
}

if (typeof globalThis.URL === 'undefined') {
  globalThis.URL = require('node:url').URL;
}

if (typeof globalThis.URLSearchParams === 'undefined') {
  globalThis.URLSearchParams = require('node:url').URLSearchParams;
}

// performance.now: Node's own (global since Node 16); perf_hooks as a fallback.
if (typeof globalThis.performance === 'undefined' || typeof globalThis.performance.now !== 'function') {
  globalThis.performance = require('node:perf_hooks').performance;
}

// requestAnimationFrame / cancelAnimationFrame: callbacks are queued and never
// run on their own, so a game loop started at load time stays frozen and the
// test process can exit.  Ids start at 1 and only grow, as in browsers, so
// `if (rafId)` checks work.  cancelAnimationFrame drops a queued callback
// (unknown ids are ignored).  flushAnimationFrames(timestamp) runs the
// callbacks queued so far once, with timestamp (default performance.now());
// frames they request go to the next flush.  It returns how many ran.
var animationFrames = [];
var pendingFrames = {};
var nextAnimationFrameId = 1;

if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = function (callback) {
    var frame = { id: nextAnimationFrameId++, callback: callback, cancelled: false };
    animationFrames.push(frame);
    pendingFrames[frame.id] = frame;
    return frame.id;
  };
}

if (typeof globalThis.cancelAnimationFrame === 'undefined') {
  globalThis.cancelAnimationFrame = function (id) {
    var frame = pendingFrames[id];
    if (!frame) return;
    frame.cancelled = true;
    delete pendingFrames[id];
    animationFrames = animationFrames.filter(function (f) { return f !== frame; });
  };
}

function flushAnimationFrames(timestamp) {
  var batch = animationFrames;
  var time = timestamp === undefined ? globalThis.performance.now() : timestamp;
  var ran = 0;
  animationFrames = [];
  batch.forEach(function (frame) {
    if (frame.cancelled) return;
    delete pendingFrames[frame.id];
    ran++;
    frame.callback(time);
  });
  return ran;
}

// useClock(t, options): one mocked clock for timers, performance.now() and,
// optionally, animation frames, so a timed game runs as a tab in view would.
// Call it before booting the game (init starts its timers on the mock).
//   options.apis    the t.mock.timers APIs, default ['setInterval',
//                   'setTimeout'] (a mock already enabled for t is reset
//                   and enabled again with these).
//   options.now     what performance.now() returns at the start, default 0.
//   options.frames  true: after every millisecond the queued animation frames
//                   run once with performance.now() as their timestamp.
// Returns { now(), elapsed(), advance(ms), at(ms) }: advance(ms) moves time
// forward one millisecond at a time (performance.now() grows, due timers fire
// through t.mock.timers.tick(1), then the frames run); at(ms) advances until
// ms milliseconds have passed since useClock (never backwards: it throws).
// Node 20's mock timers keep firing an interval that clearInterval cleared
// from inside its own callback (Node 22+ stop it): advance only to the point
// where the game stops its interval, or make the game guard with a flag.
//   const clock = useClock(t, { frames: true });
//   bootLikeBrowser('snake-game/script.js', spec);
//   clock.advance(1200);
function useClock(t, options) {
  options = options || {};
  var apis = options.apis || ['setInterval', 'setTimeout'];
  try {
    t.mock.timers.enable({ apis: apis });
  } catch (error) {
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: apis });
  }
  var start = Number(options.now) || 0;
  var now = start;
  t.mock.method(globalThis.performance, 'now', function () { return now; });
  var clock = {
    now: function () { return now; },
    elapsed: function () { return now - start; },
    advance: function (ms) {
      for (var i = 0; i < ms; i++) {
        now += 1;
        t.mock.timers.tick(1);
        if (options.frames) flushAnimationFrames(now);
      }
      return clock;
    },
    at: function (ms) {
      if (ms < now - start) throw new Error('useClock: at(' + ms + ') is behind the clock (' + (now - start) + ' ms)');
      return clock.advance(ms - (now - start));
    }
  };
  return clock;
}

// setTimeout / clearTimeout / setInterval / clearInterval: Node's own timers,
// passed straight through (and mirrored onto window below).  They really fire,
// so a game that starts an interval while loading keeps the test process alive
// until it is cleared: a game's script.js must return before its init when
// module.exports exists (the vahac-tools convention), and a test that starts a
// game's timer must stop it, or use t.mock.timers instead.

// localStorage / sessionStorage: working in-memory Storage objects.  getItem
// returns null for a missing key, setItem stores String(value), removeItem,
// clear, key(index) and length behave as in browsers.  Unlike the other stubs
// they are always installed: Node 22+ has its own Web Storage (behind
// --experimental-webstorage) that is file-backed and throws without
// --localstorage-file, and tests need a private store.  Each test file runs in
// its own process, so a store lives for one file; resetStubs() empties both.
function createStorage() {
  var data = new Map();
  var storage = {
    key: function (index) {
      var keys = Array.from(data.keys());
      return index >= 0 && index < keys.length ? keys[index] : null;
    },
    getItem: function (key) {
      key = String(key);
      return data.has(key) ? data.get(key) : null;
    },
    setItem: function (key, value) { data.set(String(key), String(value)); },
    removeItem: function (key) { data.delete(String(key)); },
    clear: function () { data.clear(); }
  };
  Object.defineProperty(storage, 'length', {
    enumerable: true,
    get: function () { return data.size; }
  });
  return storage;
}

['localStorage', 'sessionStorage'].forEach(function (name) {
  Object.defineProperty(globalThis, name, {
    value: createStorage(),
    writable: true,
    configurable: true,
    enumerable: true
  });
});

// blockStorage(what, t): makes localStorage fail the way browsers do, until
// the returned restore() runs (also after test t when it is given, and on
// resetStubs()).  what:
//   'access' (default)  reading localStorage or window.localStorage throws a
//                       SecurityError DOMException, as with site data blocked;
//   'full'              setItem throws a QuotaExceededError DOMException
//                       (storage full) while getItem and removeItem work;
//   a method name ('getItem', 'setItem', 'removeItem', 'clear', 'key') or an
//   array of them      those methods throw a SecurityError DOMException.
// The stored data is kept and readable again after restore().
//   blockStorage('full', t);
//   const restore = blockStorage(['getItem', 'removeItem']);
function blockStorage(what, t) {
  var kinds = what === undefined ? ['access'] : [].concat(what);
  var known = ['access', 'full', 'getItem', 'setItem', 'removeItem', 'clear', 'key'];
  kinds.forEach(function (kind) {
    if (known.indexOf(kind) === -1) throw new TypeError('blockStorage: unknown kind "' + kind + '"');
  });
  var storage = globalThis.localStorage;
  var win = globalThis.window;
  var undo = [];
  function insecure() { return new DOMException('The operation is insecure.', 'SecurityError'); }
  kinds.forEach(function (kind) {
    if (kind === 'access') {
      [globalThis, win].forEach(function (scope) {
        var old = Object.getOwnPropertyDescriptor(scope, 'localStorage');
        if (scope !== globalThis && (!old || old.value !== storage)) return; // window has its own
        Object.defineProperty(scope, 'localStorage', {
          configurable: true,
          enumerable: true,
          get: function () { throw insecure(); }
        });
        undo.push(function () {
          if (old) Object.defineProperty(scope, 'localStorage', old);
          else delete scope.localStorage;
        });
      });
      return;
    }
    var method = kind === 'full' ? 'setItem' : kind;
    var had = Object.getOwnPropertyDescriptor(storage, method);
    storage[method] = function () {
      throw kind === 'full' ? new DOMException('The quota has been exceeded.', 'QuotaExceededError') : insecure();
    };
    undo.push(function () {
      if (had) Object.defineProperty(storage, method, had);
      else delete storage[method];
    });
  });
  var done = false;
  function restore() {
    removeCleanup(restore);
    if (done) return;
    done = true;
    undo.reverse().forEach(function (fn) { fn(); });
  }
  cleanups.push(restore);
  if (t && typeof t.after === 'function') t.after(restore);
  return restore;
}

// matchMedia(query): every query reports matches: false (no dark-scheme,
// reduced-motion or coarse-pointer preference); the result carries the query
// as media and has no-op listener methods (old addListener/removeListener and
// addEventListener/removeEventListener).
if (typeof globalThis.matchMedia === 'undefined') {
  globalThis.matchMedia = function (query) {
    return {
      matches: false,
      media: String(query),
      onchange: null,
      addListener: noop,
      removeListener: noop,
      addEventListener: noop,
      removeEventListener: noop,
      dispatchEvent: function () { return false; }
    };
  };
}

// Audio: new Audio(src) is a silent HTMLAudioElement.  play() resolves at once
// and clears paused, pause() sets it, load and the listener methods are no-ops,
// canPlayType returns '' and cloneNode returns another silent Audio.
function StubAudio(src) {
  this.src = src === undefined ? '' : String(src);
  this.currentTime = 0;
  this.duration = 0;
  this.volume = 1;
  this.muted = false;
  this.loop = false;
  this.paused = true;
  this.preload = 'auto';
}
StubAudio.prototype.play = function () { this.paused = false; return Promise.resolve(); };
StubAudio.prototype.pause = function () { this.paused = true; };
StubAudio.prototype.load = noop;
StubAudio.prototype.addEventListener = noop;
StubAudio.prototype.removeEventListener = noop;
StubAudio.prototype.canPlayType = function () { return ''; };
StubAudio.prototype.cloneNode = function () { return new StubAudio(this.src); };

if (typeof globalThis.Audio === 'undefined') {
  globalThis.Audio = StubAudio;
}

// AudioContext / webkitAudioContext: a silent Web Audio graph.  The nodes from
// createOscillator, createGain, createBiquadFilter, createStereoPanner,
// createDynamicsCompressor and createBufferSource connect (returning the
// destination), disconnect, start and stop without sound.  Their AudioParams
// keep .value and accept every scheduling method (setValueAtTime,
// linearRampToValueAtTime, exponentialRampToValueAtTime, setTargetAtTime, ...),
// returning the param for chaining.  createBuffer returns zero-filled channels,
// decodeAudioData resolves with a one-sample buffer.  currentTime stays 0;
// resume, suspend and close resolve and set state.
function stubAudioParam(value) {
  var param = { value: value, defaultValue: value };
  [
    'setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime',
    'setTargetAtTime', 'setValueCurveAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime'
  ].forEach(function (name) {
    param[name] = function () { return param; };
  });
  return param;
}

function stubAudioNode(context, extra) {
  var node = {
    context: context,
    connect: function (destination) { return destination; },
    disconnect: noop
  };
  Object.keys(extra).forEach(function (key) { node[key] = extra[key]; });
  return node;
}

function StubAudioContext() {
  this.currentTime = 0;
  this.sampleRate = 44100;
  this.state = 'running';
  this.onstatechange = null;
  this.destination = stubAudioNode(this, { maxChannelCount: 2 });
}
StubAudioContext.prototype.createOscillator = function () {
  return stubAudioNode(this, {
    type: 'sine', frequency: stubAudioParam(440), detune: stubAudioParam(0),
    start: noop, stop: noop, setPeriodicWave: noop, onended: null
  });
};
StubAudioContext.prototype.createGain = function () {
  return stubAudioNode(this, { gain: stubAudioParam(1) });
};
StubAudioContext.prototype.createBiquadFilter = function () {
  return stubAudioNode(this, {
    type: 'lowpass', frequency: stubAudioParam(350), detune: stubAudioParam(0),
    Q: stubAudioParam(1), gain: stubAudioParam(0)
  });
};
StubAudioContext.prototype.createStereoPanner = function () {
  return stubAudioNode(this, { pan: stubAudioParam(0) });
};
StubAudioContext.prototype.createDynamicsCompressor = function () {
  return stubAudioNode(this, {
    threshold: stubAudioParam(-24), knee: stubAudioParam(30), ratio: stubAudioParam(12),
    attack: stubAudioParam(0.003), release: stubAudioParam(0.25), reduction: 0
  });
};
StubAudioContext.prototype.createBufferSource = function () {
  return stubAudioNode(this, {
    buffer: null, loop: false, playbackRate: stubAudioParam(1), detune: stubAudioParam(0),
    start: noop, stop: noop, onended: null
  });
};
StubAudioContext.prototype.createBuffer = function (channels, length, sampleRate) {
  var data = [];
  for (var i = 0; i < channels; i++) data.push(new Float32Array(length));
  return {
    numberOfChannels: channels,
    length: length,
    sampleRate: sampleRate,
    duration: length / sampleRate,
    getChannelData: function (channel) { return data[channel]; }
  };
};
StubAudioContext.prototype.createPeriodicWave = function () { return {}; };
StubAudioContext.prototype.decodeAudioData = function (arrayBuffer, onSuccess) {
  var buffer = this.createBuffer(1, 1, this.sampleRate);
  if (typeof onSuccess === 'function') onSuccess(buffer);
  return Promise.resolve(buffer);
};
StubAudioContext.prototype.resume = function () { this.state = 'running'; return Promise.resolve(); };
StubAudioContext.prototype.suspend = function () { this.state = 'suspended'; return Promise.resolve(); };
StubAudioContext.prototype.close = function () { this.state = 'closed'; return Promise.resolve(); };

if (typeof globalThis.AudioContext === 'undefined') {
  globalThis.AudioContext = StubAudioContext;
}

if (typeof globalThis.webkitAudioContext === 'undefined') {
  globalThis.webkitAudioContext = globalThis.AudioContext;
}

// window.addEventListener / removeEventListener / dispatchEvent: the event
// target methods (see Events), so keydown, resize, blur ... listeners are
// recorded and window.dispatchEvent runs them.  Note that window is a plain
// object here, not globalThis: a script's window.foo = 1 is window.foo, and a
// bare foo afterwards would be a ReferenceError (it works in a browser).
(function () {
  var methods = eventTargetMethods(globalThis.window);
  Object.keys(methods).forEach(function (name) {
    if (typeof globalThis.window[name] === 'undefined') globalThis.window[name] = methods[name];
  });
})();

// Browser globals are also properties of window: mirror the globals above onto
// it without overwriting anything already there, so `localStorage` and
// `window.localStorage` are the same object.
[
  'document', 'location', 'history', 'navigator', 'performance',
  'localStorage', 'sessionStorage', 'matchMedia',
  'requestAnimationFrame', 'cancelAnimationFrame',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'Audio', 'AudioContext', 'webkitAudioContext'
].forEach(function (name) {
  if (typeof globalThis.window[name] === 'undefined') {
    globalThis.window[name] = globalThis[name];
  }
});

// Pages and browser boots still installed, newest last; each entry is the
// function that undoes one (it removes itself from the list).
var cleanups = [];

function removeCleanup(fn) {
  var at = cleanups.indexOf(fn);
  if (at !== -1) cleanups.splice(at, 1);
}

// resetStubs() (for t.beforeEach): restores every page (createPage install,
// loadWithPage keep), browser boot (bootLikeBrowser) and blocked storage
// (blockStorage) still in place, newest first, empties both storages, drops
// queued animation frames, drops the listeners the registry holds for
// document, window and document.body, and puts document.documentElement,
// visibilityState ('visible'), hidden (false) and activeElement
// (document.body) back.  Methods a test assigned itself
// (document.getElementById = ..., document.addEventListener = ...) are left
// alone.
function resetStubs() {
  cleanups.splice(0).reverse().forEach(function (undo) { undo(); });
  globalThis.localStorage.clear();
  globalThis.sessionStorage.clear();
  animationFrames = [];
  pendingFrames = {};
  var doc = globalThis.document;
  var win = globalThis.window;
  if (doc && typeof doc === 'object') {
    listenerRegistry.delete(doc);
    doc.visibilityState = documentDefaults.visibilityState;
    doc.hidden = documentDefaults.hidden;
    doc.documentElement = documentDefaults.documentElement;
    if (doc.body) {
      if (!doc.body.parentNode) doc.documentElement.appendChild(doc.body);
      listenerRegistry.delete(doc.body);
      doc.activeElement = doc.body;
    }
    listenerRegistry.delete(doc.documentElement);
  }
  if (win && typeof win === 'object') listenerRegistry.delete(win);
}

// loadScript(relativePath): require() any file under the repo root fresh (the
// require cache is busted, so every call gives a new copy of a game's module
// state) and return its exports.  module exists, so a game's start-up guard
// skips init.
//   const tf8 = loadScript('2048-game/script.js');
function loadScript(relativePath) {
  var abs = path.resolve(REPO_ROOT, relativePath);
  delete require.cache[require.resolve(abs)];
  return require(abs);
}

// ── Pages ───────────────────────────────────────────────────────────────────
//
// createPage(spec, options) builds the elements of a page as stubs, ready to
// be installed behind document.getElementById.
//   spec: an array of ids (each a DIV), a map id -> tagName ('canvas'), or a
//   map id -> props (htmlPageSpec builds one from index.html).  props:
//     tagName (or tag)  the element's tag, default 'div'
//     parent            the id of the page element to nest it in (default:
//                       the page root)
//     attributes        { name: value } passed to setAttribute (data-* end up
//                       in dataset, as with stubElement)
//     style, dataset    merged into el.style / el.dataset (style may also be
//                       a 'a: b; c: d' string)
//     anything else     assigned as is: className, textContent, value,
//                       disabled, hidden, width, height ...
//   options.createMissing: getElementById(id) for an id the spec lacks
//   creates a DIV (recorded in page.missing) instead of returning null.
// The page: { els, root, requested, missing, installed, get, add, install,
// restore }.
//   els        id -> element.
//   root       a DIV holding the elements, appended to document.body while
//              installed, so events on page elements bubble to document and
//              window, and pressKey on a focused page element reaches the
//              document's keydown listeners.
//   requested  every id looked up through the page while installed, first
//              lookup first (unknown ids included).
//   get(id)    els[id] or null, not recorded in requested.
//   add(id, tagNameOrProps) creates one more element and returns it.
//   install()  makes document.getElementById(id) return the page's element
//              (null for unknown ids) and document.querySelector('#id') /
//              querySelectorAll('#id') find it; other compound selectors
//              (tag, *, .class, #id, [attr=value], :focus ... and
//              combinations like 'input.sdk-cell', in a comma list; see
//              compileSelector) match every element in the page tree, the
//              ones a game appended included, in document order
//              (querySelectorAll returns an array); anything else
//              (combinators, other pseudo-classes) goes to the previous
//              querySelector / querySelectorAll.  Appends root to document.body.  No-op while
//              installed.  Returns the page.
//   restore()  undoes install (resetStubs does it too).  Idempotent.  A
//              lookup function a test or t.mock put back after restore just
//              forwards to the original, so it never sees a stale page.
//   const page = createPage({ 'snp-game-canvas': 'canvas', 'snp-score': { textContent: '0' } }).install();
var pages = new WeakSet();
var ID_SELECTOR = /^\s*#([A-Za-z_ -￿-][\w -￿-]*)\s*$/;
// The pieces of a compound selector compileSelector reads.
var SELECTOR_TAG = /^([a-zA-Z][\w-]*|\*)/;
var SELECTOR_ID = /^#([\w -￿-]+)/;
var SELECTOR_CLASS = /^\.([\w -￿-]+)/;
var SELECTOR_ATTRIBUTE = /^\[\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s"'\]]+))\s*)?\]/;
var SELECTOR_PSEUDO = /^:([\w-]+)(?![\w(-])/;
var SELECTOR_PSEUDOS = ['focus', 'focus-visible', 'focus-within', 'disabled', 'enabled', 'checked'];

// compileSelector(selector): a matcher for a comma list of compound selectors,
// or null for anything else.  A compound selector is an optional tag or *
// followed by any number of #id, .class, [attr], [attr=value] (also ~=, |=,
// ^=, $= and *=, with a quoted or bare value) and the pseudo-classes :focus,
// :focus-visible (see focusElement), :focus-within, :disabled, :enabled and
// :checked: 'button.sdk-cell', '[data-row="3"]', 'input:disabled'.
// Combinators (' ', >, +, ~) and every other pseudo-class give null, and the
// caller falls back (a page's querySelector to the previous lookup, an
// element's matches() to false, closest() to null).  [attr] reads
// getAttribute(name) and, for data-*, el.dataset as well, so a game's
// cell.dataset.row = 3 matches [data-row="3"].
function compileSelector(selector) {
  var parts = String(selector).split(',').map(function (part) { return part.trim(); });
  var matchers = [];
  for (var i = 0; i < parts.length; i++) {
    var matcher = compileCompound(parts[i]);
    if (!matcher) return null;
    matchers.push(matcher);
  }
  return function (el) {
    return matchers.some(function (matches) { return matches(el); });
  };
}

function compileCompound(text) {
  if (!text) return null;
  var tests = [];
  var rest = text;
  var m = SELECTOR_TAG.exec(rest);
  if (m) {
    if (m[1] !== '*') tests.push(tagTest(m[1].toUpperCase()));
    rest = rest.slice(m[0].length);
  }
  while (rest) {
    if ((m = SELECTOR_ID.exec(rest))) {
      tests.push(idTest(m[1]));
    } else if ((m = SELECTOR_CLASS.exec(rest))) {
      tests.push(classTest(m[1]));
    } else if ((m = SELECTOR_ATTRIBUTE.exec(rest))) {
      var value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
      tests.push(attributeTest(m[1].toLowerCase(), m[2], value));
    } else if ((m = SELECTOR_PSEUDO.exec(rest)) && SELECTOR_PSEUDOS.indexOf(m[1]) !== -1) {
      tests.push(pseudoTest(m[1]));
    } else {
      return null;
    }
    rest = rest.slice(m[0].length);
  }
  return function (el) {
    return !!el && typeof el === 'object' && tests.every(function (test) { return test(el); });
  };
}

function tagTest(tag) {
  return function (el) { return el.tagName === tag; };
}

function idTest(id) {
  return function (el) { return el.id === id; };
}

function classTest(name) {
  return function (el) {
    return String(el.className || '').split(/\s+/).indexOf(name) !== -1;
  };
}

// The value of attribute name on el for [attr] selectors, or null: what
// getAttribute returns, else the dataset entry of a data-* name.
function attributeValue(el, name) {
  var value = typeof el.getAttribute === 'function' ? el.getAttribute(name) : null;
  if (value == null && name.indexOf('data-') === 0 && el.dataset) {
    var key = name.slice(5).replace(/-([a-z])/g, function (all, c) { return c.toUpperCase(); });
    if (hasOwn(el.dataset, key) && el.dataset[key] != null) value = el.dataset[key];
  }
  return value == null ? null : String(value);
}

function attributeTest(name, op, expected) {
  return function (el) {
    var value = attributeValue(el, name);
    if (value === null) return false;
    if (!op) return true;
    if (op === '=') return value === expected;
    if (op === '|=') return value === expected || value.indexOf(expected + '-') === 0;
    if (expected === '') return false;
    if (op === '~=') return value.split(/\s+/).indexOf(expected) !== -1;
    if (op === '^=') return value.indexOf(expected) === 0;
    if (op === '$=') return value.slice(-expected.length) === expected;
    return value.indexOf(expected) !== -1; // *=
  };
}

function pseudoTest(name) {
  return function (el) {
    var doc = globalThis.document;
    var active = doc && typeof doc === 'object' ? doc.activeElement : null;
    if (name === 'focus') return active === el;
    if (name === 'focus-visible') return active === el && focusVisible.has(el);
    if (name === 'focus-within') {
      return !!active && (active === el || (typeof el.contains === 'function' && el.contains(active)));
    }
    if (name === 'disabled') return !!el.disabled;
    if (name === 'enabled') return !el.disabled;
    return !!el.checked; // :checked
  };
}

// Every element below node, in document order (children only, no text).
function pageElements(node, out) {
  out = out || [];
  (node.children || []).forEach(function (child) {
    if (!child || typeof child !== 'object' || !child.tagName) return;
    out.push(child);
    pageElements(child, out);
  });
  return out;
}

function specEntries(spec) {
  if (spec == null) return [];
  if (Array.isArray(spec)) {
    return spec.map(function (item) {
      if (item && typeof item === 'object') return [String(item.id), item];
      return [String(item), {}];
    });
  }
  if (typeof spec === 'object') {
    return Object.keys(spec).map(function (id) {
      var value = spec[id];
      return [id, typeof value === 'string' ? { tagName: value } : (value || {})];
    });
  }
  throw new TypeError('createPage: spec must be an array of ids or a map of id -> tagName / props');
}

function styleObject(value) {
  if (typeof value !== 'string') return value || {};
  var out = {};
  value.split(';').forEach(function (decl) {
    var at = decl.indexOf(':');
    if (at <= 0) return;
    var name = decl.slice(0, at).trim();
    if (name.indexOf('--') !== 0) name = name.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
    out[name] = decl.slice(at + 1).trim();
  });
  return out;
}

function applyProps(el, props) {
  Object.keys(props).forEach(function (key) {
    var value = props[key];
    if (key === 'tagName' || key === 'tag' || key === 'parent' || key === 'id') return;
    if (key === 'attributes') {
      Object.keys(value || {}).forEach(function (name) { el.setAttribute(name, value[name]); });
    } else if (key === 'style') {
      Object.assign(el.style, styleObject(value));
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else {
      el[key] = value;
    }
  });
}

function createPage(spec, options) {
  options = options || {};
  var els = {};
  var root = stubElement('div');
  var installed = false;
  var saved = {};
  var page;

  function build(id, props) {
    var el = stubElement(props.tagName || props.tag || 'div');
    el.id = id;
    applyProps(el, props);
    els[id] = el;
    return el;
  }

  function place(id, props) {
    var parent = root;
    if (props.parent != null) {
      parent = els[props.parent];
      if (!parent) throw new Error('createPage: #' + id + ' names an unknown parent "' + props.parent + '"');
    }
    parent.appendChild(els[id]);
  }

  function lookup(id) {
    id = String(id);
    if (page.requested.indexOf(id) === -1) page.requested.push(id);
    if (hasOwn(els, id)) return els[id];
    if (!options.createMissing) return null;
    page.missing.push(id);
    return root.appendChild(build(id, {}));
  }

  function getElementById(id) {
    if (!installed) return saved.getElementById.apply(globalThis.document, arguments);
    return lookup(id);
  }

  function querySelector(selector) {
    if (installed) {
      var m = ID_SELECTOR.exec(String(selector));
      if (m) return lookup(m[1]);
      var matches = compileSelector(selector);
      if (matches) return pageElements(root).filter(matches)[0] || null;
    }
    return saved.querySelector.apply(globalThis.document, arguments);
  }

  function querySelectorAll(selector) {
    if (installed) {
      var m = ID_SELECTOR.exec(String(selector));
      if (m) {
        var el = lookup(m[1]);
        return el ? [el] : [];
      }
      var matches = compileSelector(selector);
      if (matches) return pageElements(root).filter(matches);
    }
    return saved.querySelectorAll.apply(globalThis.document, arguments);
  }

  var mine = {
    getElementById: getElementById,
    querySelector: querySelector,
    querySelectorAll: querySelectorAll
  };

  function install() {
    if (installed) return page;
    var doc = globalThis.document;
    Object.keys(mine).forEach(function (name) {
      // Keep the original if a test or t.mock put this page's lookup back.
      if (doc[name] !== mine[name]) saved[name] = doc[name];
      doc[name] = mine[name];
    });
    if (doc.body) doc.body.appendChild(root);
    installed = true;
    cleanups.push(restore);
    return page;
  }

  function restore() {
    removeCleanup(restore);
    if (!installed) return page;
    installed = false;
    var doc = globalThis.document;
    Object.keys(mine).forEach(function (name) {
      if (doc[name] === mine[name]) doc[name] = saved[name];
    });
    root.remove();
    return page;
  }

  page = {
    els: els,
    root: root,
    requested: [],
    missing: [],
    get: function (id) { return hasOwn(els, id) ? els[id] : null; },
    add: function (id, props) {
      props = typeof props === 'string' ? { tagName: props } : (props || {});
      build(String(id), props);
      place(String(id), props);
      return els[id];
    },
    install: install,
    restore: restore
  };
  Object.defineProperty(page, 'installed', { enumerable: true, get: function () { return installed; } });

  var entries = specEntries(spec);
  entries.forEach(function (entry) { build(entry[0], entry[1]); });
  entries.forEach(function (entry) { place(entry[0], entry[1]); });
  pages.add(page);
  return page;
}

// loadWithPage(relativePath, spec, options) -> { exports, els, page, restore }
// Loads the script fresh (loadScript) while a page is installed, for scripts
// that look their elements up while they load.  spec is a createPage spec or
// a page from createPage (options.createMissing goes to createPage).  The page
// is restored as soon as the script has loaded, unless options.keep is true
// (for scripts that call getElementById later, in init or in handlers): then
// it stays until restore() or resetStubs().  A page that was already
// installed is left installed either way.
//   const { exports: tf8, els } = loadWithPage('2048-game/script.js', idsInHtml(html));
//   const g = loadWithPage('wordle-game/script.js', spec, { keep: true }); g.exports.init();
function loadWithPage(relativePath, spec, options) {
  options = options || {};
  var page = pages.has(spec) ? spec : createPage(spec, options);
  var wasInstalled = page.installed;
  var exports;
  page.install();
  try {
    exports = loadScript(relativePath);
  } catch (error) {
    if (!wasInstalled) page.restore();
    throw error;
  }
  if (!wasInstalled && !options.keep) page.restore();
  return { exports: exports, els: page.els, page: page, restore: page.restore };
}

// The classic inline <script> blocks of an HTML file (no src, no non-JS
// type), each as the whole file with everything outside that block blanked
// to spaces (newlines kept), so line / column numbers in stack traces and
// coverage offsets match the HTML file.
function inlineScriptSources(html) {
  var out = [];
  var re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  var m;
  function blank(text) { return text.replace(/[^\r\n]/g, ' '); }
  while ((m = re.exec(html))) {
    var attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    var type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    if (type && !/^(text|application)\/(javascript|ecmascript)$/i.test(type[1])) continue;
    var start = m.index + m[0].indexOf('>') + 1;
    var end = start + m[2].length;
    out.push(blank(html.slice(0, start)) + m[2] + blank(html.slice(end)));
  }
  return out;
}

// bootLikeBrowser(relativePath, spec, options)
//   -> { els, page, exposed, window, document, ready, restore }
// Runs a script the way a browser page does, in this test's own globals:
// vm.runInThisContext(source, { filename: <absolute path> }), so there is no
// module, exports or require in scope and the start-up guard takes the
// browser branch: init() runs at once, or with options.readyState 'loading'
// the script registers its DOMContentLoaded listener and ready() fires it.
// The page (spec as in loadWithPage) stays installed until restore().
//   relativePath  a script under the repo root; an .html file runs each of
//                 its inline classic <script> blocks in order instead (the
//                 hub's index.html).
//   options.readyState  document.readyState while the script runs and until
//                 restore(): 'complete' (default), 'interactive' or 'loading'.
//   options.source  run this text instead of the file's (the filename stays
//                 relativePath's).  For harness tests and one-off scripts;
//                 coverage maps it onto the file on disk, so it is only
//                 meaningful there when the text is the file's.
//   options.createMissing  passed to createPage.
// Result:
//   els, page   the installed page.
//   exposed     what the script put on window (window.sdkNewGame ...) and on
//               the global object (top-level var / function), by name: names
//               it added or gave a new value (a loadScript earlier in the
//               file may have set the same name already).  The values are on
//               window / globalThis as usual too.
//   ready()     document.readyState 'interactive', DOMContentLoaded on
//               document (it bubbles to window), readyState 'complete', then
//               load on window.
//   restore()   like unloading the page: restores the page and readyState,
//               removes the listeners added to document, window,
//               document.body and document.documentElement since the boot
//               (by the script or anyone else),
//               and deletes the exposed names from window and the global
//               object (or puts back the value a name had before the boot),
//               so a second boot (a reload) starts clean.
//               resetStubs() does it too.  Idempotent.
// Whatever init() registers on document / window lands in the listener
// registry (see Events) unless the test replaced those methods: drive it with
// pressKey / fire / dispatchEvent and check it with listenersOf.  Timers that
// init starts are real unless the test called t.mock.timers.enable first.
// If the script throws, everything is restored and the error is rethrown.
// Coverage: code run this way IS counted.  Measured on Node 24.18 with
// `node --test --experimental-test-coverage --test-coverage-include=<file>`
// and with run({ coverage: true }) (npm run coverage), and on Node 20.17 with
// --experimental-test-coverage: the V8 coverage of the vm script is reported
// under its filename and merged with any require()'d copy of the same file.
//   t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
//   const b = bootLikeBrowser('wordle-game/script.js', htmlPageSpec(readRepoFile('wordle-game/index.html')));
//   pressKey('a');
function bootLikeBrowser(relativePath, spec, options) {
  options = options || {};
  var abs = path.resolve(REPO_ROOT, relativePath);
  var text = options.source !== undefined ? String(options.source) : fs.readFileSync(abs, 'utf8');
  var sources = /\.html?$/i.test(abs) ? inlineScriptSources(text) : [text];
  var page = pages.has(spec) ? spec : createPage(spec, options);
  var doc = globalThis.document;
  var win = globalThis.window;
  var pageWasInstalled = page.installed;
  var previousReadyState = doc.readyState;
  var scopes = [win, globalThis].map(function (obj) {
    var before = {};
    Object.getOwnPropertyNames(obj).forEach(function (name) {
      before[name] = Object.getOwnPropertyDescriptor(obj, name);
    });
    return { obj: obj, before: before, touched: [] };
  });
  var exposed = {};
  var restored = false;
  var pageTargets = [doc, win, doc.body, doc.documentElement];
  var listenersBefore = pageTargets.map(registryRecords);

  // Names the script added to window / the global object, or gave a new value.
  function collectExposed() {
    scopes.forEach(function (scope) {
      Object.getOwnPropertyNames(scope.obj).forEach(function (name) {
        var old = scope.before[name];
        if (old && (!hasOwn(old, 'value') || Object.is(old.value, scope.obj[name]))) return;
        scope.touched.push(name);
        if (!hasOwn(exposed, name)) exposed[name] = scope.obj[name];
      });
    });
  }

  function restore() {
    removeCleanup(restore);
    if (restored) return;
    restored = true;
    if (!pageWasInstalled) page.restore();
    doc.readyState = previousReadyState;
    pageTargets.forEach(function (target, i) {
      registryRecords(target).forEach(function (record) {
        if (listenersBefore[i].indexOf(record) === -1) removeRecord(target, record);
      });
    });
    scopes.forEach(function (scope) {
      scope.touched.forEach(function (name) {
        var old = scope.before[name];
        try {
          if (old) Object.defineProperty(scope.obj, name, old);
          else delete scope.obj[name];
        } catch (e) {
          scope.obj[name] = old ? old.value : undefined; // a top-level var is not configurable
        }
      });
    });
  }

  function ready() {
    doc.readyState = 'interactive';
    doc.dispatchEvent(createEvent('DOMContentLoaded'));
    doc.readyState = 'complete';
    win.dispatchEvent(createEvent('load'));
  }

  page.install();
  doc.readyState = options.readyState || 'complete';
  cleanups.push(restore);
  // `node -e` and the REPL have a global module: hide it while the script runs.
  var globalModule = Object.getOwnPropertyDescriptor(globalThis, 'module');
  if (globalModule) delete globalThis.module;
  try {
    sources.forEach(function (code) {
      vm.runInThisContext(code, { filename: abs });
    });
  } catch (error) {
    if (globalModule) Object.defineProperty(globalThis, 'module', globalModule);
    collectExposed();
    restore();
    throw error;
  }
  if (globalModule) Object.defineProperty(globalThis, 'module', globalModule);
  collectExposed();
  return {
    els: page.els,
    page: page,
    exposed: exposed,
    window: win,
    document: doc,
    ready: ready,
    restore: restore
  };
}

// ── Randomness ──────────────────────────────────────────────────────────────

// seeded(seed): a reproducible stand-in for Math.random (mulberry32): a
// function returning numbers in [0, 1), the same sequence for the same seed.
//   t.mock.method(Math, 'random', seeded(7));
function seeded(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Source checks ───────────────────────────────────────────────────────────

// readRepoFile(relPath): a file under the repo root as UTF-8 text, with CRLF
// line endings turned into LF, so source checks pass the same on a Windows
// checkout (core.autocrlf=true) as on Linux.
//   const html = readRepoFile('2048-game/index.html');
function readRepoFile(relPath) {
  return fs.readFileSync(path.resolve(REPO_ROOT, relPath), 'utf8').replace(/\r\n/g, '\n');
}

// The markup of an HTML text with comments and the contents of <script> and
// <style> elements removed (the tags themselves stay).
function markupOnly(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi, '$1$2')
    .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style\s*>)/gi, '$1$2');
}

// Attributes of a start tag's attribute text as [[name, value]] in order;
// names lower-cased, value '' for a bare (boolean) attribute.
function parseAttributes(text) {
  var out = [];
  var re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  var m;
  while ((m = re.exec(text))) {
    var value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    out.push([m[1].toLowerCase(), decodeEntities(value)]);
  }
  return out;
}

function decodeEntities(text) {
  var named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };
  return String(text).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, function (all, name) {
    if (name[0] === '#') {
      var code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return hasOwn(named, name.toLowerCase()) ? named[name.toLowerCase()] : all;
  });
}

var START_TAG = /<\/?([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
var VOID_TAGS = [
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'source', 'track', 'wbr'
];

// idsInHtml(html): every id="..." value of the markup in document order,
// duplicates kept (so a test can check they are unique).  Comments and the
// contents of <script> / <style> are skipped, so ids inside an inline
// script's strings do not count.
//   createPage(idsInHtml(readRepoFile('minesweeper/index.html')))
function idsInHtml(html) {
  var ids = [];
  var src = markupOnly(html);
  var m;
  START_TAG.lastIndex = 0;
  while ((m = START_TAG.exec(src))) {
    if (m[0][1] === '/') continue;
    parseAttributes(m[2]).forEach(function (attr) {
      if (attr[0] === 'id') ids.push(attr[1]);
    });
  }
  return ids;
}

// htmlPageSpec(html): a createPage spec mirroring every element with an id:
// { id: { tagName, parent?, className?, attributes?, style?, textContent?,
// value?, type?, disabled?, hidden?, checked?, readOnly?, width?, height? } }.
//   tagName     lower-case tag; parent the id of the nearest ancestor that has
//               one (omitted at the top), so contains() and bubbling follow
//               the markup.
//   class -> className, style="" -> style (camelCased), type, value,
//   disabled / hidden / checked / readonly -> true; canvas / img width and
//   height -> numbers; every attribute except id and class also goes to
//   attributes (aria-*, role, data-* ...).
//   textContent the decoded text of an element whose only content is text
//   (whitespace kept); a <textarea>'s text becomes its value; a <select>'s
//   value is its selected <option>'s value, else the first option's.
// The first element wins for a duplicated id, as with getElementById.  A
// regex reading for this repo's hand-written markup, not an HTML parser.
//   const page = createPage(htmlPageSpec(readRepoFile('snake-game/index.html')));
function htmlPageSpec(html) {
  var src = markupOnly(html);
  var spec = {};
  var stack = [];
  var m;
  START_TAG.lastIndex = 0;
  while ((m = START_TAG.exec(src))) {
    var tag = m[1].toLowerCase();
    if (m[0][1] === '/') {
      for (var i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    var attrs = parseAttributes(m[2]);
    var selfClosing = VOID_TAGS.indexOf(tag) !== -1 || /\/\s*$/.test(m[2]);
    var id = null;
    attrs.forEach(function (attr) { if (attr[0] === 'id' && id === null) id = attr[1]; });
    if (id && !hasOwn(spec, id)) {
      spec[id] = elementProps(tag, attrs, stack, selfClosing ? '' : src.slice(START_TAG.lastIndex));
    }
    if (!selfClosing) stack.push({ tag: tag, id: id });
  }
  return spec;
}

function elementProps(tag, attrs, stack, after) {
  var props = { tagName: tag };
  for (var i = stack.length - 1; i >= 0; i--) {
    if (stack[i].id) {
      props.parent = stack[i].id;
      break;
    }
  }
  var attributes = {};
  attrs.forEach(function (attr) {
    var name = attr[0];
    var value = attr[1];
    if (name === 'id') return;
    if (name === 'class') {
      props.className = value;
      return;
    }
    attributes[name] = value;
    if (name === 'style') props.style = styleObject(value);
    else if (name === 'type' || name === 'value') props[name] = value;
    else if (name === 'disabled' || name === 'hidden' || name === 'checked') props[name] = true;
    else if (name === 'readonly') props.readOnly = true;
    else if ((name === 'width' || name === 'height') && (tag === 'canvas' || tag === 'img')) props[name] = Number(value);
  });
  if (Object.keys(attributes).length) props.attributes = attributes;
  if (tag === 'select') {
    var selectEnd = after.search(/<\/select\s*>/i);
    var body = selectEnd === -1 ? after : after.slice(0, selectEnd);
    var options = [];
    var re = /<option\b((?:[^>"']|"[^"]*"|'[^']*')*)>([^<]*)/gi;
    var o;
    while ((o = re.exec(body))) {
      var optionAttrs = parseAttributes(o[1]);
      var option = { value: decodeEntities(o[2]).trim(), selected: false };
      optionAttrs.forEach(function (attr) {
        if (attr[0] === 'value') option.value = attr[1];
        if (attr[0] === 'selected') option.selected = true;
      });
      options.push(option);
    }
    var chosen = options.filter(function (opt) { return opt.selected; })[0] || options[0];
    if (chosen && props.value === undefined) props.value = chosen.value;
  } else if (after) {
    var lt = after.indexOf('<');
    var text = lt === -1 ? after : after.slice(0, lt);
    var closes = new RegExp('^</' + tag + '\\s*>', 'i').test(after.slice(lt));
    if (lt !== -1 && closes && text !== '') {
      if (tag === 'textarea') props.value = decodeEntities(text);
      else props.textContent = decodeEntities(text);
    }
  }
  return props;
}

// embedMarkup(html): the part of a game's index.html that build-embed copies
// into the WordPress block: from the first <div class="<prefix>-wrapper" up to
// the first <script after it ('' when there is no wrapper div).
//   assert.deepEqual(embedSafety(embedMarkup(readRepoFile('sudoku/index.html'))), []);
function embedMarkup(html) {
  html = String(html);
  var start = html.search(/<div\s+class="[a-z0-9]{2,4}-wrapper[\s"]/);
  if (start === -1) return '';
  var end = html.indexOf('<script', start);
  return html.slice(start, end === -1 ? html.length : end);
}

// embedSafety(text): every '<!--', '-->' and '</script' (any case) in text as
// { token, index, line, column, excerpt } in source order; [] when the text is
// safe inside the WordPress tool-embed block.  line / column are 1-based.
//   assert.deepEqual(embedSafety(readRepoFile('snake-game/script.js')), []);
function embedSafety(text) {
  var s = String(text);
  var lower = s.toLowerCase();
  var found = [];
  ['<!--', '-->', '</script'].forEach(function (token) {
    var at = lower.indexOf(token);
    while (at !== -1) {
      var before = s.slice(0, at);
      var lineStart = before.lastIndexOf('\n') + 1;
      found.push({
        token: token,
        index: at,
        line: before.split('\n').length,
        column: at - lineStart + 1,
        excerpt: s.slice(Math.max(0, at - 20), at + token.length + 20)
      });
      at = lower.indexOf(token, at + 1);
    }
  });
  return found.sort(function (a, b) { return a.index - b.index; });
}

// Index of the brace / semicolon that ends the text at `from`, skipping
// quoted strings and parentheses: the first of `stops` found at depth 0.
function scanCss(css, from, stops) {
  var depth = 0;
  for (var i = from; i < css.length; i++) {
    var c = css[i];
    if (c === '"' || c === '\'') {
      var close = css.indexOf(c, i + 1);
      i = close === -1 ? css.length : close;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      if (depth) depth--;
    } else if (!depth && stops.indexOf(c) !== -1) {
      return i;
    }
  }
  return -1;
}

function matchingBrace(css, open) {
  var depth = 0;
  for (var i = open; i < css.length; i++) {
    var c = css[i];
    if (c === '"' || c === '\'') {
      var close = css.indexOf(c, i + 1);
      i = close === -1 ? css.length : close;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (!depth) return i;
    }
  }
  return css.length;
}

function splitCss(text, separator) {
  var parts = [];
  var start = 0;
  var at;
  while ((at = scanCss(text, start, separator)) !== -1) {
    parts.push(text.slice(start, at));
    start = at + 1;
  }
  parts.push(text.slice(start));
  return parts.map(function (part) { return part.trim(); }).filter(Boolean);
}

function cssLength(value, unit) {
  return Number(value) * (unit === 'em' || unit === 'rem' ? 16 : 1);
}

function mediaWidths(media) {
  var maxWidth = Infinity;
  var minWidth = 0;
  var m;
  var re = /\(\s*(max|min)-width\s*:\s*([\d.]+)(px|em|rem)?\s*\)|\(\s*width\s*(<=?|>=?)\s*([\d.]+)(px|em|rem)?\s*\)/g;
  while ((m = re.exec(media))) {
    var kind = m[1] || (m[4][0] === '<' ? 'max' : 'min');
    var px = m[1] ? cssLength(m[2], m[3]) : cssLength(m[5], m[6]);
    if (kind === 'max') maxWidth = Math.min(maxWidth, px);
    else minWidth = Math.max(minWidth, px);
  }
  return { maxWidth: maxWidth, minWidth: minWidth };
}

// cssRules(css): the style rules of a stylesheet in source order as
//   { selectors, decls, media, maxWidth, minWidth, supports, keyframes }
//   selectors  the selector list split at top-level commas, each trimmed and
//              with runs of whitespace collapsed ('.a  .b' -> '.a .b').
//   decls      property -> value as written (trimmed, '!important' kept); a
//              property repeated in one rule keeps its last value.
//   media      '' outside @media, else the condition text ('(max-width:
//              480px)'); nested @media conditions are joined with ' and '.
//   maxWidth / minWidth  px from max-width / min-width (or width <= / >=)
//              conditions in media (em / rem count 16 px): Infinity / 0 when
//              there is none.
//   supports   the @supports condition(s), '' when none.
//   keyframes  the @keyframes name for its 'from' / '50%' blocks, '' otherwise.
// Comments are dropped; @import / @charset statements and other block
// at-rules (@font-face, @page ...) are skipped, except @layer / @container,
// whose rules are kept.  No CSS nesting.
// Generalises the parser tests/2048-game.test.js had (there media was N for
// "@media (max-width: Npx)" and Infinity outside: that N is maxWidth now).
//   const rules = cssRules(readRepoFile('2048-game/style.css'));
function cssRules(css) {
  var src = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  var rules = [];
  parseCssBlock(src, { media: [], supports: [], keyframes: '' }, rules);
  return rules;
}

function parseCssBlock(css, ctx, rules) {
  var i = 0;
  while (i < css.length) {
    var at = scanCss(css, i, '{};');
    if (at === -1) return;
    var prelude = css.slice(i, at).trim();
    if (css[at] !== '{') {
      i = at + 1; // a statement at-rule or a stray brace
      continue;
    }
    var close = matchingBrace(css, at);
    var body = css.slice(at + 1, close);
    i = close + 1;
    var atRule = /^@([\w-]+)\s*([\s\S]*)$/.exec(prelude);
    if (atRule) {
      var name = atRule[1].toLowerCase();
      var condition = atRule[2].trim();
      if (name === 'media') {
        parseCssBlock(body, { media: ctx.media.concat(condition), supports: ctx.supports, keyframes: ctx.keyframes }, rules);
      } else if (name === 'supports') {
        parseCssBlock(body, { media: ctx.media, supports: ctx.supports.concat(condition), keyframes: ctx.keyframes }, rules);
      } else if (/(^|-)keyframes$/.test(name)) {
        parseCssBlock(body, { media: ctx.media, supports: ctx.supports, keyframes: condition }, rules);
      } else if (name === 'layer' || name === 'container') {
        parseCssBlock(body, ctx, rules);
      }
      continue;
    }
    var decls = {};
    splitCss(body, ';').forEach(function (decl) {
      var colon = decl.indexOf(':');
      if (colon > 0) decls[decl.slice(0, colon).trim()] = decl.slice(colon + 1).trim();
    });
    var media = ctx.media.join(' and ');
    var widths = mediaWidths(media);
    rules.push({
      selectors: splitCss(prelude, ',').map(function (s) { return s.replace(/\s+/g, ' '); }),
      decls: decls,
      media: media,
      maxWidth: widths.maxWidth,
      minWidth: widths.minWidth,
      supports: ctx.supports.join(' and '),
      keyframes: ctx.keyframes
    });
  }
}

// True when a media condition tests nothing but the viewport width.
function widthOnlyMedia(media) {
  return media
    .replace(/\(\s*(max-|min-)?width\s*:[^)]*\)/g, '')
    .replace(/\(\s*width\s*[<>]=?[^)]*\)/g, '')
    .replace(/\b(only|screen|all|and)\b/g, '')
    .trim() === '';
}

// declsAt(rules, selector, viewportWidth, options): the declarations that
// apply to one selector (exact text, whitespace collapsed) at a viewport
// width, merged in source order so a later rule wins (equal specificity
// assumed; !important ignored).  Rules inside @keyframes never apply.  A rule
// under @media applies when the width is within its minWidth..maxWidth and
// its condition tests only the width; any other condition (prefers-*, hover,
// print ...) applies only when options.matchMedia(conditionText) returns
// true, so by default those rules are skipped, like the matchMedia stub.
//   declsAt(rules, '.tf8-board', 375)['max-width']
function declsAt(rules, selector, viewportWidth, options) {
  var wanted = String(selector).trim().replace(/\s+/g, ' ');
  var matchMedia = options && options.matchMedia;
  var out = {};
  rules.forEach(function (rule) {
    if (rule.keyframes || rule.selectors.indexOf(wanted) === -1) return;
    if (rule.media) {
      if (viewportWidth > rule.maxWidth || viewportWidth < rule.minWidth) return;
      if (!widthOnlyMedia(rule.media) && !(matchMedia && matchMedia(rule.media))) return;
    }
    Object.assign(out, rule.decls);
  });
  return out;
}

module.exports = {
  // browser stubs
  loadScript: loadScript,
  stubElement: stubElement,
  createStorage: createStorage,
  blockStorage: blockStorage,
  flushAnimationFrames: flushAnimationFrames,
  useClock: useClock,
  seeded: seeded,
  resetStubs: resetStubs,
  // events
  makeEventTarget: makeEventTarget,
  createEvent: createEvent,
  keyEvent: keyEvent,
  touchEvent: touchEvent,
  fire: fire,
  pressKey: pressKey,
  swipe: swipe,
  focusElement: focusElement,
  typeInto: typeInto,
  setVisibility: setVisibility,
  listenersOf: listenersOf,
  listenerCount: listenerCount,
  // pages and loading
  createPage: createPage,
  loadWithPage: loadWithPage,
  bootLikeBrowser: bootLikeBrowser,
  // source checks
  REPO_ROOT: REPO_ROOT,
  readRepoFile: readRepoFile,
  idsInHtml: idsInHtml,
  htmlPageSpec: htmlPageSpec,
  embedMarkup: embedMarkup,
  embedSafety: embedSafety,
  cssRules: cssRules,
  declsAt: declsAt
};
