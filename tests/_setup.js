// tests/_setup.js
// Minimal DOM / browser-global stubs so game script.js files can be require()'d
// in Node without throwing.  Copied from vahac-tools/tests/_setup.js and
// extended with what browser games touch: animation frames, timers, Web
// Storage, matchMedia, canvas, audio and vibration.
//
// A stub is installed only when Node lacks the global, so Node's own version
// always wins (Web Storage is the one exception, see below).  The element stubs
// keep a little state (classes, attributes, children) so a test can look at
// what a game built, but nothing here parses HTML, matches selectors, lays out
// or draws anything, and no game loop runs by itself: animation frames only
// run when a test calls flushAnimationFrames().

'use strict';

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

// Element stub.  stubElement(tagName) defaults to a DIV; a CANVAS starts at
// 300x150 like the browser default.
//   - classList: see stubClassList; style: see stubStyle; dataset: plain object.
//   - setAttribute/getAttribute/hasAttribute/removeAttribute keep a private
//     attribute map (names lower-cased); id, class and data-* are mirrored onto
//     el.id, el.className and el.dataset.  getAttribute returns null for an
//     attribute that was never set.
//   - appendChild/insertBefore/removeChild/remove keep children, childNodes,
//     firstChild/lastChild and parentElement/parentNode up to date (appending a
//     child moves it out of its old parent).  removeChild of a non-child is
//     ignored rather than throwing.  contains(node) walks the tracked children.
//   - innerHTML/textContent store the string as-is (no parsing); setting either
//     drops the tracked children, as replacing an element's content does.
//   - querySelector returns null and querySelectorAll [] (no selector engine);
//     closest returns null and matches false.
//   - addEventListener/removeEventListener/focus/blur/select/click/
//     scrollIntoView are no-ops; dispatchEvent returns true.
//   - getBoundingClientRect returns a rect at (0, 0) sized by el.width/el.height
//     (300x150 for a canvas, 0x0 otherwise); offset*/client* sizes are 0.
//   - getContext('2d') returns one context per element (see stubCanvasContext);
//     any other context type returns null.  toDataURL returns 'data:,'.
//   - cloneNode returns a fresh stub with the same tag name.
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
      }
    });
    el.children.length = 0;
    el.childNodes.length = 0;
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
      el.children.push(child);
      el.childNodes.push(child);
      child.parentElement = el;
      child.parentNode = el;
      return child;
    },
    insertBefore: function (child, ref) {
      detach(child);
      var at = ref == null ? -1 : el.childNodes.indexOf(ref);
      if (at === -1) {
        el.children.push(child);
        el.childNodes.push(child);
      } else {
        el.children.splice(el.children.indexOf(ref), 0, child);
        el.childNodes.splice(at, 0, child);
      }
      child.parentElement = el;
      child.parentNode = el;
      return child;
    },
    removeChild: function (child) {
      var at = el.childNodes.indexOf(child);
      if (at !== -1) {
        el.childNodes.splice(at, 1);
        el.children.splice(el.children.indexOf(child), 1);
        child.parentElement = null;
        child.parentNode = null;
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
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: function () { return true; },
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
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    closest: function () { return null; },
    matches: function () { return false; },
    focus: noop,
    blur: noop,
    select: noop,
    click: noop,
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

  Object.defineProperties(el, {
    innerHTML: {
      enumerable: true,
      get: function () { return html; },
      set: function (value) {
        html = value == null ? '' : String(value);
        clearChildren();
      }
    },
    textContent: {
      enumerable: true,
      get: function () { return text; },
      set: function (value) {
        text = value == null ? '' : String(value);
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

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    readyState: 'complete',
    body: stubElement('body'),
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: function () { return true; },
    getElementById: function () { return null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    createElement: function (tagName) { return stubElement(tagName); },
    execCommand: function () { return true; }
  };
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

// window.addEventListener / removeEventListener: no-ops (keydown, resize,
// blur ... listeners are accepted and never called); dispatchEvent returns true.
if (typeof globalThis.window.addEventListener === 'undefined') {
  globalThis.window.addEventListener = noop;
}

if (typeof globalThis.window.removeEventListener === 'undefined') {
  globalThis.window.removeEventListener = noop;
}

if (typeof globalThis.window.dispatchEvent === 'undefined') {
  globalThis.window.dispatchEvent = function () { return true; };
}

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

// Empty both storages and drop queued animation frames (for t.beforeEach).
function resetStubs() {
  globalThis.localStorage.clear();
  globalThis.sessionStorage.clear();
  animationFrames = [];
  pendingFrames = {};
}

// Load any script.js file fresh (bust the require cache) and return its exports.
function loadScript(relativePath) {
  var path = require('node:path');
  var abs = path.resolve(__dirname, '..', relativePath);
  delete require.cache[require.resolve(abs)];
  return require(abs);
}

module.exports = {
  loadScript: loadScript,
  stubElement: stubElement,
  createStorage: createStorage,
  flushAnimationFrames: flushAnimationFrames,
  resetStubs: resetStubs
};
