// Pod Packer — script.js
// Prefix: pdp-
// Dependencies: none.
//
// You are the scheduler of a small cluster.  Each level has a few nodes with
// CPU and memory capacity and a queue of pods, each asking for some CPU and
// some memory.  Tap a pending pod, then a node: the pod runs there when it
// fits and breaks no placement rule; otherwise the refusal names the values
// ("Insufficient memory: pod api-2 needs 1.5 GiB, node-3 has 1.0 GiB free.").
// While a pending pod is picked, a tap anywhere on a node card, the pods on
// it included, runs the picked pod on that node; with nothing picked, a tap
// on a pod on a node evicts it back to the queue.  A level is scheduled
// when every pod runs, the draining node is empty and no more nodes run pods
// than the target.
//
// Score: what a scheduler optimises.  Nodes used (fewer is better; the level
// is passed only within the target), evictions and moves.  The target is the
// exact minimum number of nodes, found by a bounded branch-and-bound search
// (pdpMinNodes); when the search runs out of its step budget the generator's
// own node count is shown as a par instead (an upper bound).  The minimum
// evictions are the pods that start on the draining node, the minimum moves
// one placement per pod plus one eviction per such pod.  Undo is a shortcut
// for the opposite action, so it counts the same way: undoing a placement
// is an eviction and a move, undoing an eviction is a move.  An eviction
// from the draining node is final (the node takes no pods back), so it is
// never put on the undo history, and a saved history that would need one is
// dropped: every entry left on the history can always be undone.
//
// Rules arrive early: anti-affinity (replicas of one app never share a node,
// level 2), a taint with tolerations (only pods that tolerate gpu run on the
// gpu node, and the ml pod needs that node, level 3), and a draining node
// (it takes no pods and its pods must move, level 4).  From level 5 they
// combine.  Levels are built constructively (pdpGenerate): the generator
// picks the nodes of a solution, cuts each one's capacity into pods (the
// replicas of the anti-affinity app first, each on another node; the gpu
// node's pods tolerate the taint), adds a spare node and the draining node
// holding some of those pods, then shuffles nodes and pods.  So every level
// has a schedule within the target under every rule it turns on.  Level N
// always uses the seed FNV-1a("pdp:level-N") through mulberry32, so it is the
// same for every visitor; Math.random is never used.
//
// Keys: only while the focus is on the cluster (the board or one of its
// pods): arrows pick a pod, 1-6 run the picked pod on that node, E evicts
// it, U undoes, N starts the next level once this one is passed, Escape
// clears the pick.  Ctrl / Alt / Cmd combinations and held keys (other than
// the arrows) are left alone, and so is every key typed elsewhere: on the
// host page and on the game's own buttons, select and help, where the arrows
// keep scrolling the page.  When a level is rebuilt while a pod has the
// focus, the board takes it, so the keys keep working.
//
// Saves: pdp-state (level number, seed, placement, undo history and the
// counters) and pdp-progress (the highest level passed and the best moves and
// evictions of each).  Every field is checked on load and falls back on its
// own; storage that is blocked or full never stops the game, and a warning
// names the key that is not saved.
//
// Tabs: pdp-progress is read again and merged before it is written, so no tab
// erases another tab's record.  A level another tab saved since is taken
// over (through the storage event, when the tab is shown again, and before
// every action, which is then dropped: taps, keys, Undo, Restart, Next level
// and the level list) instead of being written over.  A storage warning goes
// away once a later write of that key succeeds.
//
// Start-up: under Node (module.exports exists) loading only exports the
// functions for the tests; in a browser pdpInit runs on DOMContentLoaded, or
// at once when the page has already loaded.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var PDP_STATE_KEY = 'pdp-state';
  var PDP_PROGRESS_KEY = 'pdp-progress';
  var PDP_SAVE_VERSION = 1;

  var PDP_MAX_LEVEL = 50;
  var PDP_HISTORY_LIMIT = 200;
  var PDP_SEARCH_BUDGET = 200000;
  var PDP_TOAST_MS = 2600;

  // Sizes are counted in halves: 3 is 1.5 CPU or 1.5 GiB.
  var PDP_CPU_SIZES = [4, 6, 8, 12];
  var PDP_MEM_SIZES = [4, 8, 12, 16];
  var PDP_MAX_PODS_PER_HOST = 4;

  var PDP_TAINT = 'gpu';
  var PDP_GPU_APP = 'ml';
  var PDP_APPS = ['api', 'web', 'auth', 'cache', 'queue', 'search', 'mail', 'log', 'cron', 'proxy', 'store',
    'metrics', 'report', 'backup'];

  // The levels: k solution nodes, spare nodes, pods, replicas of the
  // anti-affinity app (0: none), a gpu taint, pods on a draining node (0:
  // none).  Levels past the table repeat its last row.
  var PDP_LEVELS = [
    { k: 2, spare: 1, pods: 5, anti: 0, taint: false, drain: 0 },
    { k: 2, spare: 1, pods: 5, anti: 2, taint: false, drain: 0 },
    { k: 2, spare: 1, pods: 6, anti: 0, taint: true, drain: 0 },
    { k: 2, spare: 1, pods: 6, anti: 0, taint: false, drain: 2 },
    { k: 3, spare: 1, pods: 7, anti: 2, taint: true, drain: 0 },
    { k: 3, spare: 1, pods: 8, anti: 2, taint: false, drain: 2 },
    { k: 3, spare: 1, pods: 8, anti: 0, taint: true, drain: 2 },
    { k: 3, spare: 1, pods: 9, anti: 2, taint: true, drain: 2 },
    { k: 4, spare: 0, pods: 10, anti: 3, taint: true, drain: 2 },
    { k: 4, spare: 1, pods: 10, anti: 3, taint: true, drain: 3 },
    { k: 4, spare: 1, pods: 11, anti: 3, taint: true, drain: 3 },
    { k: 4, spare: 1, pods: 12, anti: 3, taint: true, drain: 3 }
  ];

  // Each saved key and what it holds, for the storage warning.
  var PDP_SAVED = [
    { key: PDP_STATE_KEY, what: 'the level in progress' },
    { key: PDP_PROGRESS_KEY, what: 'your passed levels and best scores' }
  ];

  // Keys by KeyboardEvent.key (lower-cased), then by the physical key for
  // layouts whose letters are not Latin.  Digits 1-6 pick a node.
  var PDP_KEYS = {
    arrowleft: 'prev',
    arrowup: 'prev',
    arrowright: 'next',
    arrowdown: 'next',
    e: 'evict',
    u: 'undo',
    n: 'advance',
    escape: 'clear'
  };
  var PDP_CODES = { KeyE: 'evict', KeyU: 'undo', KeyN: 'advance' };

  // ── State ─────────────────────────────────────────────────────────────────

  // game: { level, place, history, moves, evictions } (pdpNewGame).  level:
  // the generated level (pdpBuildLevel).  place: per pod the index of its
  // node, -1 while pending.  history: [pod, from, to] per action, newest
  // last (from or to is -1 for the queue).  progress: pdpParseProgress.
  // built: the level the elements on screen were made for.  selected: the
  // picked pod, -1 for none (never saved).  stateText / progressText: the
  // stored text this tab last read or wrote, so a change another tab made
  // since stands out.  failed: key -> error name of a storage access that
  // failed.
  var pdpRuntime = {
    els: null,
    game: null,
    progress: null,
    built: null,
    podEls: [],
    nodeEls: [],
    selected: -1,
    optionsKey: '',
    toastTimeout: null,
    failed: {},
    stateText: null,
    progressText: null
  };

  // ── Helpers (no DOM) ──────────────────────────────────────────────────────

  function pdpHasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function pdpFill(length, value) {
    var out = [];
    for (var i = 0; i < length; i++) {
      out.push(value);
    }
    return out;
  }

  function pdpRange(length) {
    var out = [];
    for (var i = 0; i < length; i++) {
      out.push(i);
    }
    return out;
  }

  function pdpPlural(count, word) {
    return count + ' ' + word + (count === 1 ? '' : 's');
  }

  // A size in halves as text with one decimal: 3 -> '1.5'.
  function pdpUnits(halves) {
    return (halves / 2).toFixed(1);
  }

  function pdpCpuText(halves) {
    return pdpUnits(halves) + ' CPU';
  }

  function pdpMemText(halves) {
    return pdpUnits(halves) + ' GiB';
  }

  // ── Random numbers (no DOM) ───────────────────────────────────────────────

  // FNV-1a, 32 bit, over the UTF-16 code units of text.
  function pdpHash(text) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  // mulberry32: a seeded generator of numbers in [0, 1).
  function pdpMulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var x = a;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  // The seed of level number: the same for every visitor.
  function pdpLevelSeed(number) {
    return pdpHash('pdp:level-' + number);
  }

  function pdpPick(list, rnd) {
    return list[Math.floor(rnd() * list.length)];
  }

  // A shuffled copy of list (Fisher-Yates with rnd).
  function pdpShuffle(list, rnd) {
    var out = list.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var keep = out[i];
      out[i] = out[j];
      out[j] = keep;
    }
    return out;
  }

  // total cut into parts whole numbers of at least 1 that add up to total
  // (parts <= total), every such cut equally likely: parts - 1 distinct cut
  // points out of 1 .. total - 1, drawn by a partial Fisher-Yates shuffle.
  function pdpCut(total, parts, rnd) {
    var points = pdpRange(total - 1).map(function (i) {
      return i + 1;
    });
    for (var i = 0; i < parts - 1; i++) {
      var j = i + Math.floor(rnd() * (points.length - i));
      var keep = points[i];
      points[i] = points[j];
      points[j] = keep;
    }
    var cuts = points.slice(0, parts - 1).sort(function (a, b) {
      return a - b;
    });
    var out = [];
    var last = 0;
    cuts.forEach(function (cut) {
      out.push(cut - last);
      last = cut;
    });
    out.push(total - last);
    return out;
  }

  // ── Levels (no DOM) ───────────────────────────────────────────────────────

  function pdpLevelSpec(number) {
    return PDP_LEVELS[Math.min(number, PDP_LEVELS.length) - 1];
  }

  function pdpIsLevel(value) {
    return typeof value === 'number' && value % 1 === 0 && value >= 1 && value <= PDP_MAX_LEVEL;
  }

  function pdpMakePod(app, replica, cpu, mem, anti, tolerates, needs) {
    return {
      name: app + '-' + replica,
      app: app,
      cpu: cpu,
      mem: mem,
      anti: anti,
      tolerates: tolerates,
      needs: needs
    };
  }

  function pdpMakeNode(rnd) {
    return { name: '', cpu: pdpPick(PDP_CPU_SIZES, rnd), mem: pdpPick(PDP_MEM_SIZES, rnd), taint: null, drain: false };
  }

  // How many pods each of the k solution nodes gets: two each, the rest one
  // at a time to a random node that has fewer than four.
  function pdpPodCounts(spec, rnd) {
    var counts = pdpFill(spec.k, 2);
    for (var i = 2 * spec.k; i < spec.pods; i++) {
      var open = [];
      counts.forEach(function (count, h) {
        if (count < PDP_MAX_PODS_PER_HOST) {
          open.push(h);
        }
      });
      counts[pdpPick(open, rnd)]++;
    }
    return counts;
  }

  // Puts the pods of the draining node there at the start: spec.drain pods
  // of distinct apps that need no gpu node, picked at random.  Returns the
  // draining node, sized to hold them (rounded up to whole units).
  function pdpDrainPods(pods, start, count, at, rnd) {
    var seen = {};
    var cpu = 0;
    var mem = 0;
    pdpShuffle(pdpRange(pods.length), rnd).forEach(function (p) {
      var pod = pods[p];
      if (count > 0 && pod.needs === null && !pdpHasOwn(seen, pod.app)) {
        seen[pod.app] = true;
        start[p] = at;
        cpu += pod.cpu;
        mem += pod.mem;
        count--;
      }
    });
    return { name: '', cpu: 2 * Math.ceil(cpu / 2), mem: 2 * Math.ceil(mem / 2), taint: null, drain: true };
  }

  // A new level: { number, nodes, pods, start, solution, upper }, see the
  // header.  nodes: { name, cpu, mem, taint, drain }; pods: { name, app, cpu,
  // mem, anti, tolerates, needs }; start: the placement the level begins
  // with (-1 pending, or the draining node); solution: a placement within
  // the target that the generator built; upper: its number of nodes.  rnd
  // gives numbers in [0, 1).
  function pdpGenerate(number, rnd) {
    var spec = pdpLevelSpec(number);
    var hosts = [];
    var i;
    for (i = 0; i < spec.k; i++) {
      hosts.push(pdpMakeNode(rnd));
    }
    if (spec.taint) {
      hosts[spec.k - 1].taint = PDP_TAINT;
    }
    var counts = pdpPodCounts(spec, rnd);
    var room = hosts.map(function (host, h) {
      return { cpu: host.cpu, mem: host.mem, left: counts[h] };
    });
    var apps = pdpShuffle(PDP_APPS, rnd);
    var pods = [];
    var solution = [];
    if (spec.anti) {
      // Identical replicas, one on each of the first spec.anti nodes (the
      // gpu node is the last one), each leaving room for that node's others.
      var app = apps.shift();
      var maxCpu = Infinity;
      var maxMem = Infinity;
      for (i = 0; i < spec.anti; i++) {
        maxCpu = Math.min(maxCpu, room[i].cpu - room[i].left + 1);
        maxMem = Math.min(maxMem, room[i].mem - room[i].left + 1);
      }
      var cpu = 1 + Math.floor(rnd() * maxCpu);
      var mem = 1 + Math.floor(rnd() * maxMem);
      for (i = 0; i < spec.anti; i++) {
        pods.push(pdpMakePod(app, i + 1, cpu, mem, true, null, null));
        solution.push(i);
        room[i].cpu -= cpu;
        room[i].mem -= mem;
        room[i].left--;
      }
    }
    hosts.forEach(function (host, h) {
      var cpus = pdpCut(room[h].cpu, room[h].left, rnd);
      var mems = pdpCut(room[h].mem, room[h].left, rnd);
      var gpu = host.taint !== null;
      cpus.forEach(function (cpuPart, p) {
        var needs = gpu && p === 0;
        pods.push(pdpMakePod(needs ? PDP_GPU_APP : apps.shift(), 1, cpuPart, mems[p], false,
          gpu ? PDP_TAINT : null, needs ? PDP_TAINT : null));
        solution.push(h);
      });
    });
    var nodes = hosts.slice();
    for (i = 0; i < spec.spare; i++) {
      nodes.push(pdpMakeNode(rnd));
    }
    var start = pdpFill(pods.length, -1);
    if (spec.drain) {
      nodes.push(pdpDrainPods(pods, start, spec.drain, nodes.length, rnd));
    }
    // Shuffle the nodes and the queue, and name the nodes in screen order.
    var nodeOrder = pdpShuffle(pdpRange(nodes.length), rnd);
    var nodeAt = [];
    nodeOrder.forEach(function (old, j) {
      nodeAt[old] = j;
    });
    var podOrder = pdpShuffle(pdpRange(pods.length), rnd);
    return {
      number: number,
      nodes: nodeOrder.map(function (old, j) {
        var node = nodes[old];
        node.name = 'node-' + (j + 1);
        return node;
      }),
      pods: podOrder.map(function (old) {
        return pods[old];
      }),
      start: podOrder.map(function (old) {
        return start[old] === -1 ? -1 : nodeAt[start[old]];
      }),
      solution: podOrder.map(function (old) {
        return nodeAt[solution[old]];
      }),
      upper: spec.k
    };
  }

  // Why pod podIndex cannot run on node nodeIndex next to the pods place
  // puts there ('' when it can): the draining node takes nothing, a taint
  // needs a toleration, a pod that needs a gpu node needs one, a replica of
  // an anti-affinity app never joins another one, and the CPU and memory
  // left have to be enough.
  function pdpRefusal(lv, place, podIndex, nodeIndex) {
    var node = lv.nodes[nodeIndex];
    var pod = lv.pods[podIndex];
    if (node.drain) {
      return node.name + ' is draining: it accepts no new pods.';
    }
    if (node.taint !== null && pod.tolerates !== node.taint) {
      return 'Taint ' + node.taint + ' on ' + node.name + ': pod ' + pod.name + ' has no toleration for it.';
    }
    if (pod.needs !== null && node.taint !== pod.needs) {
      return 'Node selector: pod ' + pod.name + ' needs a ' + pod.needs + ' node, and ' + node.name + ' has no ' +
        pod.needs + '.';
    }
    var cpu = 0;
    var mem = 0;
    var twin = null;
    for (var i = 0; i < place.length; i++) {
      if (place[i] === nodeIndex && i !== podIndex) {
        var other = lv.pods[i];
        cpu += other.cpu;
        mem += other.mem;
        if (pod.anti && other.app === pod.app) {
          twin = other;
        }
      }
    }
    if (twin !== null) {
      return 'Anti-affinity: pod ' + pod.name + ' cannot share ' + node.name + ' with ' + twin.name + ' (app ' +
        pod.app + ').';
    }
    var cpuFree = node.cpu - cpu;
    var memFree = node.mem - mem;
    var cpuShort = pod.cpu > cpuFree;
    var memShort = pod.mem > memFree;
    if (cpuShort && memShort) {
      return 'Insufficient cpu and memory: pod ' + pod.name + ' needs ' + pdpCpuText(pod.cpu) + ' and ' +
        pdpMemText(pod.mem) + ', ' + node.name + ' has ' + pdpCpuText(cpuFree) + ' and ' + pdpMemText(memFree) +
        ' free.';
    }
    if (cpuShort) {
      return 'Insufficient cpu: pod ' + pod.name + ' needs ' + pdpCpuText(pod.cpu) + ', ' + node.name + ' has ' +
        pdpCpuText(cpuFree) + ' free.';
    }
    if (memShort) {
      return 'Insufficient memory: pod ' + pod.name + ' needs ' + pdpMemText(pod.mem) + ', ' + node.name + ' has ' +
        pdpMemText(memFree) + ' free.';
    }
    return '';
  }

  // The fewest nodes that run every pod under every rule, at most upper (a
  // count known to work): a depth-first search that places the largest pods
  // first and opens a new node only while that can still beat the best
  // found.  Each node tried is a step; past budget steps the search stops
  // and the result is not exact.  Returns { nodes, exact }.
  function pdpMinNodes(lv, upper, budget) {
    var pods = lv.pods;
    var order = pdpRange(pods.length).sort(function (a, b) {
      return pods[b].cpu + pods[b].mem - pods[a].cpu - pods[a].mem || a - b;
    });
    var place = pdpFill(pods.length, -1);
    var count = pdpFill(lv.nodes.length, 0);
    var best = upper;
    var steps = 0;
    var aborted = false;
    function search(k, used) {
      if (k === order.length) {
        best = used;
        return;
      }
      var pod = order[k];
      for (var j = 0; j < lv.nodes.length && !aborted; j++) {
        steps++;
        if (steps > budget) {
          aborted = true;
        } else if ((count[j] > 0 || used + 1 < best) && !pdpRefusal(lv, place, pod, j)) {
          place[pod] = j;
          count[j]++;
          search(k + 1, count[j] === 1 ? used + 1 : used);
          count[j]--;
          place[pod] = -1;
        }
      }
    }
    search(0, 0);
    return { nodes: best, exact: !aborted };
  }

  // Level number generated from seed, with its target and its minimum
  // evictions and moves.
  function pdpBuildLevel(number, seed) {
    var lv = pdpGenerate(number, pdpMulberry32(seed));
    var stranded = lv.start.filter(function (node) {
      return node !== -1;
    }).length;
    lv.seed = seed;
    lv.target = pdpMinNodes(lv, lv.upper, PDP_SEARCH_BUDGET);
    lv.minEvictions = stranded;
    lv.minMoves = lv.pods.length + stranded;
    return lv;
  }

  function pdpDrainIndex(lv) {
    for (var j = 0; j < lv.nodes.length; j++) {
      if (lv.nodes[j].drain) {
        return j;
      }
    }
    return -1;
  }

  // The CPU and memory (halves) and the number of pods place puts on node.
  function pdpUsage(lv, place, node) {
    var use = { cpu: 0, mem: 0, pods: 0 };
    place.forEach(function (at, i) {
      if (at === node) {
        use.cpu += lv.pods[i].cpu;
        use.mem += lv.pods[i].mem;
        use.pods++;
      }
    });
    return use;
  }

  // How many nodes run pods, the draining node not counted.
  function pdpUsedNodes(lv, place) {
    return lv.nodes.filter(function (node, j) {
      return !node.drain && place.indexOf(j) !== -1;
    }).length;
  }

  function pdpCountAt(place, node) {
    return place.filter(function (at) {
      return at === node;
    }).length;
  }

  function pdpNewGame(lv) {
    return { level: lv, place: lv.start.slice(), history: [], moves: 0, evictions: 0 };
  }

  // Every pod runs, the draining node is empty and the nodes used are
  // within the target.
  function pdpIsPassed(game) {
    var lv = game.level;
    var drain = pdpDrainIndex(lv);
    return game.place.indexOf(-1) === -1 && (drain === -1 || game.place.indexOf(drain) === -1) &&
      pdpUsedNodes(lv, game.place) <= lv.target.nodes;
  }

  function pdpPassedText(game) {
    var number = game.level.number;
    return 'Level ' + number + ' is scheduled: ' +
      (number < PDP_MAX_LEVEL ? 'start level ' + (number + 1) + ' with Next level, or restart' : 'restart') +
      ' it to play it again.';
  }

  function pdpPushHistory(game, entry) {
    game.history.push(entry);
    if (game.history.length > PDP_HISTORY_LIMIT) {
      game.history.shift();
    }
  }

  // Applies a move to a copy of game: { type: 'place', pod, node },
  // { type: 'evict', pod } or { type: 'undo' }.  Returns { game, error }:
  // the new game and '' when the move is played, the same game and the
  // refusal otherwise.  An eviction from the draining node is not put on the
  // history (it cannot be undone), so undo never meets a refusal: the top
  // entry always leads back to the placement it was made on.
  function pdpApplyMove(game, move) {
    var lv = game.level;
    if (pdpIsPassed(game)) {
      return { game: game, error: pdpPassedText(game) };
    }
    var next = {
      level: lv,
      place: game.place.slice(),
      history: game.history.slice(),
      moves: game.moves,
      evictions: game.evictions
    };
    var error;
    if (move.type === 'undo') {
      var last = next.history.pop();
      if (!last) {
        return { game: game, error: 'Nothing to undo on level ' + lv.number + '.' };
      }
      if (last[1] === -1) {
        next.place[last[0]] = -1;
        next.evictions++;
      } else {
        next.place[last[0]] = last[1];
      }
      next.moves++;
      return { game: next, error: '' };
    }
    var pod = lv.pods[move.pod];
    var from = next.place[move.pod];
    if (move.type === 'evict') {
      if (from === -1) {
        return { game: game, error: 'Pod ' + pod.name + ' is pending: there is nothing to evict.' };
      }
      next.place[move.pod] = -1;
      next.evictions++;
      if (!lv.nodes[from].drain) {
        pdpPushHistory(next, [move.pod, from, -1]);
      }
    } else {
      if (from !== -1) {
        return { game: game, error: 'Pod ' + pod.name + ' already runs on ' + lv.nodes[from].name +
          ': evict it first (E, or tap it).' };
      }
      error = pdpRefusal(lv, next.place, move.pod, move.node);
      if (error) {
        return { game: game, error: error };
      }
      next.place[move.pod] = move.node;
      pdpPushHistory(next, [move.pod, -1, move.node]);
    }
    next.moves++;
    return { game: next, error: '' };
  }

  // The pods in screen order: the queue, then node by node.
  function pdpVisualOrder(game) {
    var order = [];
    for (var at = -1; at < game.level.nodes.length; at++) {
      game.place.forEach(function (node, i) {
        if (node === at) {
          order.push(i);
        }
      });
    }
    return order;
  }

  function pdpTargetText(lv) {
    return (lv.target.exact ? 'target ' : 'par ') + lv.target.nodes;
  }

  // The line a passed level shows: the counts against their minimums.
  function pdpResultText(game) {
    var lv = game.level;
    var optimal = game.moves === lv.minMoves && game.evictions === lv.minEvictions;
    return 'Level ' + lv.number + ' scheduled: ' + pdpPlural(lv.pods.length, 'pod') + ' on ' +
      pdpPlural(pdpUsedNodes(lv, game.place), 'node') + ' (' + pdpTargetText(lv) + '), ' +
      pdpPlural(game.evictions, 'eviction') + ' (min ' + lv.minEvictions + '), ' + pdpPlural(game.moves, 'move') +
      ' (min ' + lv.minMoves + ').' + (optimal ? ' Optimal schedule.' : '');
  }

  function pdpStatusText(game) {
    var lv = game.level;
    var drain = pdpDrainIndex(lv);
    var pending = pdpCountAt(game.place, -1);
    var stranded = drain === -1 ? 0 : pdpCountAt(game.place, drain);
    var used = pdpUsedNodes(lv, game.place);
    if (pdpIsPassed(game)) {
      return pdpResultText(game);
    }
    if (pending === 0 && stranded === 0) {
      return 'All ' + pdpPlural(lv.pods.length, 'pod') + ' run, but on ' + pdpPlural(used, 'node') + ' (' +
        pdpTargetText(lv) + '). Free a node to pass: evict its pods and fit them elsewhere.';
    }
    var parts = [pdpPlural(pending, 'pod') + ' pending'];
    if (stranded) {
      parts.push(lv.nodes[drain].name + ' still runs ' + pdpPlural(stranded, 'pod') + ' to move');
    }
    return 'Schedule every pod on at most ' + pdpPlural(lv.target.nodes, 'node') + ': ' + parts.join(', ') + '.';
  }

  function pdpGoalText(lv) {
    return 'Level ' + lv.number + ': run all ' + pdpPlural(lv.pods.length, 'pod') + ' on at most ' +
      pdpPlural(lv.target.nodes, 'node') +
      (lv.target.exact ? ' (the exact minimum).' : ' (a par: fewer may be possible).');
  }

  // The rules of a level, one line each.
  function pdpRuleLines(lv) {
    var lines = ['Resources: a pod runs only on a node with enough CPU and memory left.'];
    var replicas = lv.pods.filter(function (pod) {
      return pod.anti;
    });
    if (replicas.length) {
      lines.push('Anti-affinity: the ' + replicas.length + ' replicas of ' + replicas[0].app + ' (' +
        replicas.map(function (pod) {
          return pod.name;
        }).join(', ') + ') never share a node.');
    }
    lv.nodes.forEach(function (node) {
      if (node.taint !== null) {
        var needs = lv.pods.filter(function (pod) {
          return pod.needs === node.taint;
        }).map(function (pod) {
          return pod.name;
        });
        lines.push('Taint ' + node.taint + ' on ' + node.name + ': only pods that tolerate ' + node.taint +
          ' run there, and ' + needs.join(', ') + ' needs it.');
      }
    });
    lv.nodes.forEach(function (node, j) {
      if (node.drain) {
        lines.push('Drain ' + node.name + ': it takes no new pods; evict its ' +
          pdpPlural(pdpCountAt(lv.start, j), 'pod') + ' and run them elsewhere (Undo cannot put a pod back on it).');
      }
    });
    return lines;
  }

  function pdpPodTags(pod) {
    var tags = [];
    if (pod.anti) {
      tags.push('anti-affinity');
    }
    if (pod.needs !== null) {
      tags.push('needs ' + pod.needs);
    } else if (pod.tolerates !== null) {
      tags.push('tolerates ' + pod.tolerates);
    }
    return tags.join(' · ');
  }

  // ── Saves (no DOM) ────────────────────────────────────────────────────────

  function pdpParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  function pdpIsObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function pdpIsInteger(value) {
    return typeof value === 'number' && value % 1 === 0;
  }

  function pdpIsCount(value) {
    return pdpIsInteger(value) && value >= 0;
  }

  function pdpIsNodeRef(lv, value) {
    return pdpIsInteger(value) && value >= -1 && value < lv.nodes.length;
  }

  // Whether place is a placement of lv's pods that keeps every rule: a node
  // per pod (or -1), the draining node holding only pods it started with,
  // and every other node within its rules and capacity.
  function pdpPlacementValid(lv, place) {
    if (!Array.isArray(place) || place.length !== lv.pods.length) {
      return false;
    }
    var i;
    for (i = 0; i < place.length; i++) {
      if (!pdpIsNodeRef(lv, place[i]) || (place[i] !== -1 && lv.nodes[place[i]].drain && lv.start[i] !== place[i])) {
        return false;
      }
    }
    var built = pdpFill(place.length, -1);
    for (i = 0; i < place.length; i++) {
      if (place[i] !== -1 && !lv.nodes[place[i]].drain) {
        if (pdpRefusal(lv, built, i, place[i])) {
          return false;
        }
        built[i] = place[i];
      }
    }
    return true;
  }

  // Whether history is an undo history that leads to place: entries
  // [pod, from, to] that each moved a pod between the queue and a node,
  // read back from the newest, every one of which can be undone in turn (an
  // eviction puts its pod back only where every rule allows it, never on
  // the draining node).
  function pdpHistoryValid(lv, place, history) {
    if (!Array.isArray(history) || history.length > PDP_HISTORY_LIMIT) {
      return false;
    }
    var at = place.slice();
    for (var k = history.length - 1; k >= 0; k--) {
      var entry = history[k];
      if (!Array.isArray(entry) || entry.length !== 3 || !pdpIsInteger(entry[0]) || entry[0] < 0 ||
        entry[0] >= at.length || !pdpIsNodeRef(lv, entry[1]) || !pdpIsNodeRef(lv, entry[2]) ||
        (entry[1] === -1) === (entry[2] === -1) || at[entry[0]] !== entry[2] ||
        (entry[1] !== -1 && pdpRefusal(lv, at, entry[0], entry[1]) !== '')) {
        return false;
      }
      at[entry[0]] = entry[1];
    }
    return true;
  }

  // pdp-state as a game (pdpNewGame's shape), field by field: a level
  // number from 1 to PDP_MAX_LEVEL (else fallbackLevel), a seed (else the
  // level's), a placement that keeps the rules (else the level's start),
  // an undo history that leads to it (else none) and the two counters (else
  // 0).
  function pdpParseState(text, fallbackLevel) {
    var data = pdpParseJson(text);
    if (!pdpIsObject(data)) {
      data = {};
    }
    var known = pdpIsLevel(data.level);
    var number = known ? data.level : fallbackLevel;
    // A seed belongs to its level: without that level it is not used.
    var seed = known && pdpIsCount(data.seed) && data.seed <= 4294967295 ? data.seed : pdpLevelSeed(number);
    var lv = pdpBuildLevel(number, seed);
    var place = pdpPlacementValid(lv, data.place) ? data.place.slice() : lv.start.slice();
    return {
      level: lv,
      place: place,
      history: pdpHistoryValid(lv, place, data.history) ? data.history.map(function (entry) {
        return entry.slice();
      }) : [],
      moves: pdpIsCount(data.moves) ? data.moves : 0,
      evictions: pdpIsCount(data.evictions) ? data.evictions : 0
    };
  }

  function pdpSerializeState(game) {
    return {
      v: PDP_SAVE_VERSION,
      level: game.level.number,
      seed: game.level.seed,
      place: game.place,
      history: game.history,
      moves: game.moves,
      evictions: game.evictions
    };
  }

  // pdp-progress as { highest, levels }: levels maps a level number to its
  // best { moves, evictions } (each null when unknown); highest is the
  // highest level passed, at least the highest level with a record.
  function pdpParseProgress(text) {
    var data = pdpParseJson(text);
    if (!pdpIsObject(data)) {
      data = {};
    }
    var stored = pdpIsObject(data.levels) ? data.levels : {};
    var progress = { highest: pdpIsCount(data.highest) && data.highest <= PDP_MAX_LEVEL ? data.highest : 0, levels: {} };
    for (var number = 1; number <= PDP_MAX_LEVEL; number++) {
      var entry = pdpHasOwn(stored, String(number)) ? stored[number] : null;
      if (pdpIsObject(entry)) {
        var record = {
          moves: pdpIsCount(entry.moves) ? entry.moves : null,
          evictions: pdpIsCount(entry.evictions) ? entry.evictions : null
        };
        if (record.moves !== null || record.evictions !== null) {
          progress.levels[number] = record;
          progress.highest = Math.max(progress.highest, number);
        }
      }
    }
    return progress;
  }

  // The lower of two best values, either of which may be null (none yet).
  function pdpLower(a, b) {
    if (a === null) {
      return b;
    }
    return b === null || a <= b ? a : b;
  }

  // Two progress records merged level by level and field by field, so a
  // record one tab wrote is never lost to another tab's.
  function pdpMergeProgress(a, b) {
    var merged = { highest: Math.max(a.highest, b.highest), levels: {} };
    for (var number = 1; number <= PDP_MAX_LEVEL; number++) {
      var x = a.levels[number];
      var y = b.levels[number];
      if (x && y) {
        merged.levels[number] = { moves: pdpLower(x.moves, y.moves), evictions: pdpLower(x.evictions, y.evictions) };
      } else if (x || y) {
        merged.levels[number] = { moves: (x || y).moves, evictions: (x || y).evictions };
      }
    }
    return merged;
  }

  // Progress after passing level number with moves and evictions: returns
  // { progress, better } (better: the first pass, or fewer moves or
  // evictions than before).
  function pdpRecord(progress, number, moves, evictions) {
    var next = pdpMergeProgress(progress, { highest: number, levels: {} });
    var old = next.levels[number];
    if (!old) {
      next.levels[number] = { moves: moves, evictions: evictions };
      return { progress: next, better: true };
    }
    var better = old.moves === null || moves < old.moves || old.evictions === null || evictions < old.evictions;
    next.levels[number] = { moves: pdpLower(old.moves, moves), evictions: pdpLower(old.evictions, evictions) };
    return { progress: next, better: better };
  }

  function pdpSerializeProgress(progress) {
    return { v: PDP_SAVE_VERSION, highest: progress.highest, levels: progress.levels };
  }

  function pdpBestText(record) {
    if (!record) {
      return '--';
    }
    return (record.moves === null ? '--' : String(record.moves)) + ' / ' +
      (record.evictions === null ? '--' : String(record.evictions));
  }

  // The warning for every key whose storage failed so far (failed maps a
  // key to the error's name), naming each key and what it holds; '' if none.
  function pdpStorageWarning(failed) {
    var hit = PDP_SAVED.filter(function (item) {
      return pdpHasOwn(failed, item.key);
    });
    if (!hit.length) {
      return '';
    }
    var names = [];
    hit.forEach(function (item) {
      if (names.indexOf(failed[item.key]) === -1) {
        names.push(failed[item.key]);
      }
    });
    return 'Browser storage refused ' + hit.map(function (item) {
      return item.key;
    }).join(' and ') + ' (' + names.join(', ') + '): ' + hit.map(function (item) {
      return item.what;
    }).join(' and ') + ' will not be kept after a reload.';
  }

  // { type: 'node', node } for 1-6, { type } for the other keys, or null.  A
  // keydown without a key (Chrome autofill sends those) is null.
  function pdpKeyAction(event) {
    if (typeof event.key !== 'string') {
      return null;
    }
    var key = event.key.toLowerCase();
    var digit = /^[1-6]$/.test(key) ? key : (/^(?:Digit|Numpad)([1-6])$/.exec(String(event.code)) || [])[1];
    if (digit) {
      return { type: 'node', node: Number(digit) - 1 };
    }
    if (pdpHasOwn(PDP_KEYS, key)) {
      return { type: PDP_KEYS[key] };
    }
    return pdpHasOwn(PDP_CODES, event.code) ? { type: PDP_CODES[event.code] } : null;
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  // Shows the warning for the keys whose storage still fails, or hides it.
  function pdpRenderWarning() {
    var warning = pdpRuntime.els.warning;
    var text = pdpStorageWarning(pdpRuntime.failed);
    warning.textContent = text;
    warning.classList.toggle('pdp-hidden', !text);
  }

  function pdpStorageFailed(key, error) {
    pdpRuntime.failed[key] = String(error.name);
    pdpRenderWarning();
  }

  function pdpStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      pdpStorageFailed(key, error);
      return null;
    }
  }

  // Writes text under key and returns the text the key holds afterwards:
  // text, or what was there before when the write failed.  A write that
  // works again takes the key off the warning (a read alone does not: full
  // storage still reads).
  function pdpStorageSet(key, text) {
    try {
      localStorage.setItem(key, text);
      if (pdpHasOwn(pdpRuntime.failed, key)) {
        delete pdpRuntime.failed[key];
        pdpRenderWarning();
      }
      return text;
    } catch (error) {
      pdpStorageFailed(key, error);
      return pdpStorageGet(key);
    }
  }

  // Writes the game on screen when it changed since the last read or write,
  // or when the last write failed (so a write that works again clears the
  // warning, even for a game that matches the older text on disk).
  function pdpSaveState() {
    var text = JSON.stringify(pdpSerializeState(pdpRuntime.game));
    if (text !== pdpRuntime.stateText || pdpHasOwn(pdpRuntime.failed, PDP_STATE_KEY)) {
      pdpRuntime.stateText = pdpStorageSet(PDP_STATE_KEY, text);
    }
  }

  // Takes over the game another tab saved since this tab last read or wrote
  // pdp-state.  Returns whether it did.
  function pdpSyncState() {
    var text = pdpStorageGet(PDP_STATE_KEY);
    if (text === null || text === pdpRuntime.stateText) {
      return false;
    }
    pdpRuntime.stateText = text;
    pdpRuntime.game = pdpParseState(text, pdpRuntime.game.level.number);
    pdpRuntime.selected = -1;
    pdpRender();
    pdpShowToast('Another tab changed the game: level ' + pdpRuntime.game.level.number +
      ' is shown here as that tab left it (' + pdpPlural(pdpRuntime.game.moves, 'move') + ').');
    return true;
  }

  // Merges the progress another tab saved since into this tab's.
  function pdpSyncProgress() {
    var text = pdpStorageGet(PDP_PROGRESS_KEY);
    if (text === pdpRuntime.progressText) {
      return false;
    }
    pdpRuntime.progressText = text;
    pdpRuntime.progress = pdpMergeProgress(pdpRuntime.progress, pdpParseProgress(text));
    pdpRender();
    return true;
  }

  // Records a passed level, merged with what another tab may have stored.
  // Returns whether this pass improved the level's best.
  function pdpRecordPass(game) {
    var merged = pdpMergeProgress(pdpRuntime.progress, pdpParseProgress(pdpStorageGet(PDP_PROGRESS_KEY)));
    var result = pdpRecord(merged, game.level.number, game.moves, game.evictions);
    pdpRuntime.progress = result.progress;
    pdpRuntime.progressText = pdpStorageSet(PDP_PROGRESS_KEY, JSON.stringify(pdpSerializeProgress(result.progress)));
    return result.better;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function pdpMake(tag, className, text) {
    var el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) {
      el.textContent = text;
    }
    return el;
  }

  function pdpBuildMeter(label, kind) {
    var el = pdpMake('div', 'pdp-meter pdp-meter--' + kind);
    var bar = pdpMake('span', 'pdp-bar');
    var meter = {
      el: el,
      fill: pdpMake('span', 'pdp-bar-fill'),
      ghost: pdpMake('span', 'pdp-bar-ghost'),
      value: pdpMake('span', 'pdp-meter-value')
    };
    bar.appendChild(meter.fill);
    bar.appendChild(meter.ghost);
    el.appendChild(pdpMake('span', 'pdp-meter-label', label));
    el.appendChild(bar);
    el.appendChild(meter.value);
    return meter;
  }

  // The elements of a level, built once per level: a node card per node
  // (key, name, tags, CPU and RAM bars, its pods) and a button per pod.  A
  // pod button that had the focus goes away with the old level, so the
  // board takes the focus then, and the keys keep reaching the game.
  function pdpBuild(lv) {
    var els = pdpRuntime.els;
    var refocus = els.board.contains(document.activeElement);
    els.queue.innerHTML = '';
    els.nodes.innerHTML = '';
    els.rules.innerHTML = '';
    pdpRuntime.built = lv;
    pdpRuntime.nodeEls = lv.nodes.map(function (node, j) {
      var el = pdpMake('div', 'pdp-node');
      var head = pdpMake('div', 'pdp-node-head');
      var item = {
        el: el,
        cpu: pdpBuildMeter('CPU', 'cpu'),
        mem: pdpBuildMeter('RAM', 'mem'),
        pods: pdpMake('div', 'pdp-node-pods')
      };
      el.setAttribute('data-node', j);
      el.setAttribute('role', 'group');
      head.appendChild(pdpMake('span', 'pdp-node-key', String(j + 1)));
      head.appendChild(pdpMake('span', 'pdp-node-name', node.name));
      if (node.taint !== null) {
        head.appendChild(pdpMake('span', 'pdp-tag pdp-tag--taint', 'taint ' + node.taint));
      }
      if (node.drain) {
        head.appendChild(pdpMake('span', 'pdp-tag pdp-tag--drain', 'draining'));
      }
      el.appendChild(head);
      el.appendChild(item.cpu.el);
      el.appendChild(item.mem.el);
      el.appendChild(item.pods);
      els.nodes.appendChild(el);
      return item;
    });
    pdpRuntime.podEls = lv.pods.map(function (pod, i) {
      var el = pdpMake('button', 'pdp-pod');
      var tags = pdpPodTags(pod);
      el.type = 'button';
      el.id = 'pdp-pod-' + i;
      el.setAttribute('type', 'button');
      el.setAttribute('tabindex', '-1');
      el.setAttribute('data-pod', i);
      el.appendChild(pdpMake('span', 'pdp-pod-name', pod.name));
      el.appendChild(pdpMake('span', 'pdp-pod-size', pdpCpuText(pod.cpu) + ' · ' + pdpMemText(pod.mem)));
      if (tags) {
        el.appendChild(pdpMake('span', 'pdp-pod-tags', tags));
      }
      return el;
    });
    pdpRuleLines(lv).forEach(function (line) {
      els.rules.appendChild(pdpMake('li', 'pdp-rule', line));
    });
    if (refocus) {
      els.board.focus({ preventScroll: true });
    }
  }

  // Puts a pod's button into box in pod order, keeping the focus on it.
  function pdpMovePod(el, box, index) {
    var focused = document.activeElement === el;
    var ref = null;
    for (var c = box.children.length - 1; c >= 0; c--) {
      if (Number(box.children[c].getAttribute('data-pod')) > index) {
        ref = box.children[c];
      }
    }
    box.insertBefore(el, ref);
    if (focused) {
      el.focus();
    }
  }

  function pdpPodLabel(lv, place, i) {
    var pod = lv.pods[i];
    var tags = pdpPodTags(pod);
    return 'pod ' + pod.name + ': ' + pdpCpuText(pod.cpu) + ', ' + pdpMemText(pod.mem) + (tags ? ', ' + tags : '') +
      ', ' + (place[i] === -1 ? 'pending' : 'on ' + lv.nodes[place[i]].name);
  }

  function pdpRenderPods(game) {
    var lv = game.level;
    var els = pdpRuntime.els;
    var pending = 0;
    lv.pods.forEach(function (pod, i) {
      var el = pdpRuntime.podEls[i];
      var at = game.place[i];
      var classes = ['pdp-pod'];
      if (at === -1) {
        pending++;
      } else if (lv.nodes[at].drain) {
        classes.push('pdp-pod--stranded');
      }
      if (i === pdpRuntime.selected) {
        classes.push('pdp-pod--selected');
      }
      if (pod.anti) {
        classes.push('pdp-pod--anti');
      }
      if (pod.needs !== null) {
        classes.push('pdp-pod--gpu');
      } else if (pod.tolerates !== null) {
        classes.push('pdp-pod--tolerates');
      }
      el.className = classes.join(' ');
      el.setAttribute('aria-pressed', String(i === pdpRuntime.selected));
      el.setAttribute('aria-label', pdpPodLabel(lv, game.place, i));
      var box = at === -1 ? els.queue : pdpRuntime.nodeEls[at].pods;
      if (el.parentNode !== box) {
        pdpMovePod(el, box, i);
      }
    });
    els.pendingCount.textContent = String(pending);
    els.queueEmpty.classList.toggle('pdp-hidden', pending > 0);
  }

  // One bar: used of total, and the picked pod's size (ghost) after it,
  // marked over when it does not fit.
  function pdpDrawMeter(meter, used, total, ghost, text) {
    var free = total - used;
    meter.fill.style.width = (100 * used / total) + '%';
    meter.fill.className = 'pdp-bar-fill' + (used === total ? ' pdp-bar-fill--full' : '');
    meter.ghost.style.left = (100 * used / total) + '%';
    meter.ghost.style.width = (100 * Math.min(ghost, free) / total) + '%';
    meter.ghost.className = 'pdp-bar-ghost' + (ghost > free ? ' pdp-bar-ghost--over' : '') +
      (ghost ? '' : ' pdp-hidden');
    meter.value.textContent = pdpUnits(used) + '/' + text(total);
  }

  function pdpRenderNodes(game) {
    var lv = game.level;
    var picked = pdpRuntime.selected !== -1 && game.place[pdpRuntime.selected] === -1 ? lv.pods[pdpRuntime.selected] : null;
    lv.nodes.forEach(function (node, j) {
      var item = pdpRuntime.nodeEls[j];
      var use = pdpUsage(lv, game.place, j);
      var classes = ['pdp-node'];
      var ghost = picked && !node.drain ? picked : { cpu: 0, mem: 0 };
      if (node.drain) {
        classes.push('pdp-node--drain');
      }
      if (node.taint !== null) {
        classes.push('pdp-node--taint');
      }
      if (!use.pods) {
        classes.push('pdp-node--empty');
      }
      if (picked) {
        classes.push(pdpRefusal(lv, game.place, pdpRuntime.selected, j) ? 'pdp-node--blocked' : 'pdp-node--fits');
      }
      item.el.className = classes.join(' ');
      item.el.setAttribute('aria-label', node.name + ' (key ' + (j + 1) + '): ' + pdpUnits(use.cpu) + ' of ' +
        pdpCpuText(node.cpu) + ' and ' + pdpUnits(use.mem) + ' of ' + pdpMemText(node.mem) + ' used, ' +
        pdpPlural(use.pods, 'pod') + (node.taint !== null ? ', taint ' + node.taint : '') +
        (node.drain ? ', draining' : ''));
      pdpDrawMeter(item.cpu, use.cpu, node.cpu, ghost.cpu, pdpCpuText);
      pdpDrawMeter(item.mem, use.mem, node.mem, ghost.mem, pdpMemText);
    });
  }

  function pdpHintText(game) {
    var lv = game.level;
    var selected = pdpRuntime.selected;
    if (pdpIsPassed(game)) {
      return game.level.number < PDP_MAX_LEVEL ? 'Next level (or N) starts level ' + (lv.number + 1) +
        '. The level list replays any level you have reached.' : 'That was the last level. The level list replays any level.';
    }
    if (selected === -1) {
      return 'Tap a pending pod, then a node or a pod on it. Tap a running pod to evict it. Keys: arrows, 1-' +
        lv.nodes.length + ', E, U.';
    }
    var pod = lv.pods[selected];
    if (game.place[selected] !== -1) {
      return 'Picked ' + pod.name + ' on ' + lv.nodes[game.place[selected]].name + ': press E or tap it to evict it.';
    }
    var fits = lv.nodes.filter(function (node, j) {
      return !pdpRefusal(lv, game.place, selected, j);
    }).map(function (node) {
      return node.name;
    });
    return 'Picked ' + pod.name + ' (' + pdpCpuText(pod.cpu) + ', ' + pdpMemText(pod.mem) + '): ' +
      (fits.length ? 'fits ' + fits.join(', ') + '.' : 'fits no node now: evict a pod first.');
  }

  // The level list: every level up to the one after the highest passed (and
  // the one on screen), passed ones ticked.  Rebuilt only when it changes.
  function pdpRenderLevels(game) {
    var select = pdpRuntime.els.level;
    var progress = pdpRuntime.progress;
    var count = Math.min(PDP_MAX_LEVEL, Math.max(progress.highest + 1, game.level.number));
    var key = count + ':' + Object.keys(progress.levels).join(',');
    if (key !== pdpRuntime.optionsKey) {
      pdpRuntime.optionsKey = key;
      select.innerHTML = '';
      for (var number = 1; number <= count; number++) {
        var option = pdpMake('option', 'pdp-option', 'Level ' + number + (progress.levels[number] ? ' ✓' : ''));
        option.value = String(number);
        select.appendChild(option);
      }
    }
    select.value = String(game.level.number);
  }

  function pdpRender() {
    var els = pdpRuntime.els;
    var game = pdpRuntime.game;
    var lv = game.level;
    var passed = pdpIsPassed(game);
    var next = passed && lv.number < PDP_MAX_LEVEL;
    if (pdpRuntime.built !== lv) {
      pdpBuild(lv);
    }
    pdpRenderPods(game);
    pdpRenderNodes(game);
    pdpRenderLevels(game);
    els.board.className = 'pdp-board' + (passed ? ' pdp-board--passed' : '') +
      (pdpRuntime.selected !== -1 ? ' pdp-board--picking' : '');
    if (pdpRuntime.selected === -1) {
      els.board.removeAttribute('aria-activedescendant');
    } else {
      els.board.setAttribute('aria-activedescendant', 'pdp-pod-' + pdpRuntime.selected);
    }
    els.goal.textContent = pdpGoalText(lv);
    els.nodesUsed.textContent = String(pdpUsedNodes(lv, game.place));
    els.nodesTarget.textContent = pdpTargetText(lv);
    els.evictions.textContent = String(game.evictions);
    els.evictionsMin.textContent = 'min ' + lv.minEvictions;
    els.moves.textContent = String(game.moves);
    els.movesMin.textContent = 'min ' + lv.minMoves;
    els.best.textContent = pdpBestText(pdpRuntime.progress.levels[lv.number]);
    els.status.textContent = pdpStatusText(game);
    els.hint.textContent = pdpHintText(game);
    els.undo.disabled = passed || !game.history.length;
    els.next.classList.toggle('pdp-hidden', !next);
    els.next.textContent = 'Next level: ' + (lv.number + 1);
    els.next.setAttribute('aria-label', 'Start level ' + (lv.number + 1));
  }

  function pdpHideToast() {
    pdpRuntime.toastTimeout = null;
    pdpRuntime.els.toast.classList.remove('pdp-show');
  }

  // Shows message for PDP_TOAST_MS; a newer toast gets its full time.
  function pdpShowToast(message) {
    var toast = pdpRuntime.els.toast;
    clearTimeout(pdpRuntime.toastTimeout);
    toast.textContent = message;
    toast.classList.add('pdp-show');
    pdpRuntime.toastTimeout = setTimeout(pdpHideToast, PDP_TOAST_MS);
  }

  // ── Game flow ─────────────────────────────────────────────────────────────

  // Before an action: true when it must not run, because another tab's game
  // was taken over (the action was meant for the old one) or the level is
  // already passed (a toast says so).
  function pdpBlocked() {
    if (pdpSyncState()) {
      return true;
    }
    if (pdpIsPassed(pdpRuntime.game)) {
      pdpShowToast(pdpPassedText(pdpRuntime.game));
      return true;
    }
    return false;
  }

  // Plays the result of pdpApplyMove: a refusal becomes a toast; a played
  // move picks selectAfter, records a pass, draws and saves.
  function pdpCommit(result, selectAfter) {
    if (result.error) {
      pdpShowToast(result.error);
      return;
    }
    pdpRuntime.game = result.game;
    pdpRuntime.selected = selectAfter;
    if (pdpIsPassed(result.game)) {
      var better = pdpRecordPass(result.game);
      pdpShowToast('Level ' + result.game.level.number + ' scheduled in ' + pdpPlural(result.game.moves, 'move') +
        ' with ' + pdpPlural(result.game.evictions, 'eviction') + (better ? ': a new best.' : '.'));
    }
    pdpRender();
    pdpSaveState();
  }

  // A tap on a pod.  While a pending pod is picked, a tap on a running pod
  // is a tap on its node: the picked pod runs there (pods cover much of a
  // node card on a phone, so a tap meant for the node often lands on one).
  // Otherwise a pending pod is picked (or unpicked), and a running one is
  // evicted and stays picked.
  function pdpTapPod(index) {
    if (pdpBlocked()) {
      return;
    }
    var game = pdpRuntime.game;
    var at = game.place[index];
    var selected = pdpRuntime.selected;
    if (at !== -1 && selected !== -1 && game.place[selected] === -1) {
      pdpCommit(pdpApplyMove(game, { type: 'place', pod: selected, node: at }), -1);
      return;
    }
    if (at === -1) {
      pdpRuntime.selected = pdpRuntime.selected === index ? -1 : index;
      pdpRender();
      return;
    }
    pdpCommit(pdpApplyMove(game, { type: 'evict', pod: index }), index);
  }

  // A tap on a node, or its key: runs the picked pod there.
  function pdpTapNode(node) {
    if (pdpBlocked()) {
      return;
    }
    var lv = pdpRuntime.game.level;
    if (node >= lv.nodes.length) {
      pdpShowToast('There is no node-' + (node + 1) + ': level ' + lv.number + ' has ' +
        pdpPlural(lv.nodes.length, 'node') + '.');
      return;
    }
    if (pdpRuntime.selected === -1) {
      pdpShowToast('No pod picked: tap a pending pod first (or pick one with the arrow keys), then a node.');
      return;
    }
    pdpCommit(pdpApplyMove(pdpRuntime.game, { type: 'place', pod: pdpRuntime.selected, node: node }), -1);
  }

  function pdpEvictPicked() {
    if (pdpBlocked()) {
      return;
    }
    if (pdpRuntime.selected === -1) {
      pdpShowToast('No pod picked: pick a running pod with the arrow keys, then press E.');
      return;
    }
    pdpCommit(pdpApplyMove(pdpRuntime.game, { type: 'evict', pod: pdpRuntime.selected }), pdpRuntime.selected);
  }

  function pdpUndo() {
    if (pdpBlocked()) {
      return;
    }
    pdpCommit(pdpApplyMove(pdpRuntime.game, { type: 'undo' }), -1);
  }

  // Moves the pick along the pods in screen order (step 1 or -1).  A newer
  // game from another tab comes in first, and the step is dropped.
  function pdpStep(step) {
    if (pdpSyncState()) {
      return;
    }
    var order = pdpVisualOrder(pdpRuntime.game);
    var at = order.indexOf(pdpRuntime.selected);
    if (at === -1) {
      at = step > 0 ? 0 : order.length - 1;
    } else {
      at = (at + step + order.length) % order.length;
    }
    pdpRuntime.selected = order[at];
    pdpRender();
  }

  // ' Your level 4 attempt (5 moves) was dropped.' when starting another
  // level throws away moves of an unfinished one, '' otherwise.
  function pdpDroppedText(game) {
    if (!game.moves || pdpIsPassed(game)) {
      return '';
    }
    return ' Your level ' + game.level.number + ' attempt (' + pdpPlural(game.moves, 'move') + ') was dropped.';
  }

  function pdpStartLevel(number, seed, message) {
    var dropped = pdpDroppedText(pdpRuntime.game);
    pdpRuntime.game = pdpNewGame(pdpBuildLevel(number, seed));
    pdpRuntime.selected = -1;
    pdpRender();
    pdpSaveState();
    if (message || dropped) {
      pdpShowToast((message || 'Level ' + number + ' started.') + dropped);
    }
  }

  // Restart, Next level and the level list first take over a newer game
  // another tab saved (and then do nothing more: the click was meant for the
  // game this tab showed), so they never write a fresh level over it.
  function pdpRestart() {
    if (pdpSyncState()) {
      return;
    }
    var lv = pdpRuntime.game.level;
    pdpStartLevel(lv.number, lv.seed, 'Level ' + lv.number + ' restarted from its start.');
  }

  function pdpNextLevel() {
    if (pdpSyncState()) {
      return;
    }
    var number = pdpRuntime.game.level.number + 1;
    pdpStartLevel(number, pdpLevelSeed(number), '');
  }

  function pdpChooseLevel() {
    var number = parseInt(pdpRuntime.els.level.value, 10);
    if (pdpSyncState()) {
      return;
    }
    if (pdpIsLevel(number)) {
      pdpStartLevel(number, pdpLevelSeed(number), '');
    }
  }

  function pdpCanAdvance() {
    return pdpIsPassed(pdpRuntime.game) && pdpRuntime.game.level.number < PDP_MAX_LEVEL;
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  // Keys reach this listener only from the cluster (the board and its pod
  // buttons): the game's own buttons, select and help keep theirs, so the
  // arrows still scroll the page there.  A field inside the board (none
  // today) would keep its keys too; a held key repeats only the arrows.
  function pdpHandleKeydown(event) {
    var target = event.target;
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented ||
      /^(INPUT|SELECT|TEXTAREA)$/.test(String(target.tagName)) || target.isContentEditable === true) {
      return;
    }
    var action = pdpKeyAction(event);
    if (!action || (action.type === 'advance' && !pdpCanAdvance()) ||
      (action.type === 'clear' && pdpRuntime.selected === -1)) {
      return;
    }
    event.preventDefault();
    if (action.type === 'prev' || action.type === 'next') {
      pdpStep(action.type === 'next' ? 1 : -1);
    } else if (event.repeat) {
      return;
    } else if (action.type === 'node') {
      pdpTapNode(action.node);
    } else if (action.type === 'evict') {
      pdpEvictPicked();
    } else if (action.type === 'undo') {
      pdpUndo();
    } else if (action.type === 'advance') {
      pdpNextLevel();
    } else {
      pdpRuntime.selected = -1;
      pdpRender();
    }
  }

  // A tap or a click on the board: on a pod, else on a node card.
  function pdpHandleClick(event) {
    var pod = event.target.closest('.pdp-pod');
    if (pod) {
      pdpTapPod(Number(pod.getAttribute('data-pod')));
      return;
    }
    var node = event.target.closest('.pdp-node');
    if (node) {
      pdpTapNode(Number(node.getAttribute('data-node')));
    }
  }

  // Shown again (a tab switch, the back/forward cache): what other tabs
  // saved meanwhile comes in first.
  function pdpHandleVisibility() {
    if (!document.hidden) {
      pdpSyncProgress();
      pdpSyncState();
    }
  }

  function pdpHandleStorage(event) {
    if (event.key === PDP_STATE_KEY) {
      pdpSyncState();
    } else if (event.key === PDP_PROGRESS_KEY) {
      pdpSyncProgress();
    }
  }

  function pdpBindEvents() {
    var els = pdpRuntime.els;
    els.board.addEventListener('keydown', pdpHandleKeydown);
    els.board.addEventListener('click', pdpHandleClick);
    els.level.addEventListener('change', pdpChooseLevel);
    els.undo.addEventListener('click', pdpUndo);
    els.restart.addEventListener('click', pdpRestart);
    els.next.addEventListener('click', pdpNextLevel);
    document.addEventListener('visibilitychange', pdpHandleVisibility);
    window.addEventListener('storage', pdpHandleStorage);
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  function pdpFindElements() {
    return {
      board: document.getElementById('pdp-board'),
      queue: document.getElementById('pdp-queue'),
      queueEmpty: document.getElementById('pdp-queue-empty'),
      pendingCount: document.getElementById('pdp-pending-count'),
      nodes: document.getElementById('pdp-nodes'),
      level: document.getElementById('pdp-level'),
      undo: document.getElementById('pdp-undo'),
      restart: document.getElementById('pdp-restart'),
      next: document.getElementById('pdp-next'),
      goal: document.getElementById('pdp-goal'),
      rules: document.getElementById('pdp-rules'),
      nodesUsed: document.getElementById('pdp-nodes-used'),
      nodesTarget: document.getElementById('pdp-nodes-target'),
      evictions: document.getElementById('pdp-evictions'),
      evictionsMin: document.getElementById('pdp-evictions-min'),
      moves: document.getElementById('pdp-moves'),
      movesMin: document.getElementById('pdp-moves-min'),
      best: document.getElementById('pdp-best'),
      hint: document.getElementById('pdp-hint'),
      status: document.getElementById('pdp-status'),
      warning: document.getElementById('pdp-warning'),
      toast: document.getElementById('pdp-toast')
    };
  }

  // Finds the elements, binds the controls once and restores the saves: the
  // level in progress, or the level after the highest one passed.
  function pdpInit() {
    if (pdpRuntime.els) {
      return;
    }
    pdpRuntime.els = pdpFindElements();
    pdpBindEvents();
    pdpRuntime.progressText = pdpStorageGet(PDP_PROGRESS_KEY);
    pdpRuntime.progress = pdpParseProgress(pdpRuntime.progressText);
    pdpRuntime.stateText = pdpStorageGet(PDP_STATE_KEY);
    pdpRuntime.game = pdpParseState(pdpRuntime.stateText, Math.min(pdpRuntime.progress.highest + 1, PDP_MAX_LEVEL));
    pdpRender();
    pdpSaveState();
  }

  // Node (tests): export only, no init and no timers.  Browser: init once the
  // markup is there.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      pdpRuntime: pdpRuntime,
      pdpInit: pdpInit,
      pdpHash: pdpHash,
      pdpMulberry32: pdpMulberry32,
      pdpLevelSeed: pdpLevelSeed,
      pdpCut: pdpCut,
      pdpShuffle: pdpShuffle,
      pdpLevelSpec: pdpLevelSpec,
      pdpGenerate: pdpGenerate,
      pdpRefusal: pdpRefusal,
      pdpMinNodes: pdpMinNodes,
      pdpBuildLevel: pdpBuildLevel,
      pdpUsage: pdpUsage,
      pdpUsedNodes: pdpUsedNodes,
      pdpNewGame: pdpNewGame,
      pdpIsPassed: pdpIsPassed,
      pdpApplyMove: pdpApplyMove,
      pdpVisualOrder: pdpVisualOrder,
      pdpResultText: pdpResultText,
      pdpStatusText: pdpStatusText,
      pdpGoalText: pdpGoalText,
      pdpRuleLines: pdpRuleLines,
      pdpPodTags: pdpPodTags,
      pdpUnits: pdpUnits,
      pdpPlacementValid: pdpPlacementValid,
      pdpHistoryValid: pdpHistoryValid,
      pdpParseState: pdpParseState,
      pdpSerializeState: pdpSerializeState,
      pdpParseProgress: pdpParseProgress,
      pdpMergeProgress: pdpMergeProgress,
      pdpRecord: pdpRecord,
      pdpBestText: pdpBestText,
      pdpStorageWarning: pdpStorageWarning,
      pdpKeyAction: pdpKeyAction
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pdpInit);
  } else {
    pdpInit();
  }
})();
