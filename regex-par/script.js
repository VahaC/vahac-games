// Regex Par — script.js
// Prefix: rxp-
// Dependencies: none.
//
// Golf with regular expressions on a course of 18 holes, each made from
// lines of a real log or config file: write a pattern that catches every
// line under Catch and none under Leave.  Every character of the pattern is
// one stroke; a hole holed in fewer strokes than its par is a birdie, in more
// a bogey.  The holes, their lines and their pars are this game's own.
//
// Sandbox: every player pattern runs in a Web Worker made from a Blob of
// RXP_WORKER_SOURCE, never on the page's own thread.  A check that takes
// longer than RXP_TIMEOUT_MS is stopped with worker.terminate() and a fresh
// worker takes over, so a pattern that backtracks for minutes, such as
// (a+)+$, never hangs the host page.  Every new worker first answers a test
// pattern (within RXP_PROBE_MS) before player patterns go to it.  Where no
// worker can start (no Worker constructor, or a Content Security Policy
// that blocks blob: workers: the constructor throws, an error event arrives
// or the test pattern gets no answer) the game falls back to the main
// thread with strict limits:
// patterns up to 60 characters, test lines up to 60 characters, and a
// static check (rxpIsRisky) that counts, before the pattern runs, the most
// steps a backtracking engine can take on a line of 60 characters
// (rxpBacktrack) and refuses a pattern over RXP_MAIN_STEPS, naming the part
// at fault: nested quantifiers such as (a+)+, repeated alternatives such as
// (a|a)*, and runs such as (.?){20} or .*.*.*.*.  The mode in use is always
// shown.
//
// Rounds: Enter (or Hole out) scores the pattern in the box.  The first
// pattern that holes a hole goes on this round's card; later ones can still
// set the hole's best.  When all 18 holes are on the card the round is
// complete and its total counts for the best round.  New round clears the
// card and the drafts and keeps the bests.
//
// Keys: the pattern box owns its keys.  The game listens to Enter in that
// box only (no Ctrl, Alt or Meta, no auto-repeat, not while composing) and
// to no key anywhere else on the page.  Buttons move between holes, and a
// row of chips inserts the tokens phone keyboards hide (\d \w . * + ? [] ()
// | ^ $ {}) at the caret.
//
// Saves: rxp-state (the hole on screen, the round, a draft per hole and this
// round's card) and rxp-best (the shortest pattern per hole and the best
// round total).  Every field is checked on load and falls back on its own;
// blocked or full storage never stops the game and a warning names the key.
//
// Tabs: before every write a save is read again and merged with what
// another tab stored since (a newer round wins, a card entry is never lost,
// a shorter best always stays), and the storage event brings another tab's
// changes in at once.
//
// Start-up: under Node (module.exports exists) loading only exports the
// functions for the tests; in a browser rxpInit runs on DOMContentLoaded, or
// at once when the page has already loaded.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var RXP_STATE_KEY = 'rxp-state';
  var RXP_BEST_KEY = 'rxp-best';
  var RXP_SAVE_VERSION = 1;

  var RXP_MAX_PATTERN = 200;
  var RXP_MAIN_PATTERN = 60;
  var RXP_MAIN_LINE = 60;
  var RXP_MAIN_STEPS = 1500000;
  var RXP_TIMEOUT_MS = 300;
  var RXP_PROBE_MS = 2000;
  var RXP_TOAST_MS = 2500;
  var RXP_CONFIRM_MS = 4000;

  // The chips above the pattern box: the text each inserts and where the
  // caret goes inside it.
  var RXP_CHIPS = [
    ['\\d', 2], ['\\w', 2], ['.', 1], ['*', 1], ['+', 1], ['?', 1],
    ['[]', 1], ['()', 1], ['|', 1], ['^', 1], ['$', 1], ['{}', 1]
  ];

  var RXP_SCORE_NAMES = {
    '-3': 'albatross',
    '-2': 'eagle',
    '-1': 'birdie',
    '0': 'par',
    '1': 'bogey',
    '2': 'double bogey',
    '3': 'triple bogey'
  };

  // The course.  Every line is at most RXP_MAIN_LINE characters, so the
  // main-thread mode can test all of them.
  var RXP_HOLES = [
    {
      id: 'nginx-5xx',
      title: 'Five hundreds',
      source: 'nginx access.log',
      task: 'Catch the requests that ended in a server error (5xx). Leave the 2xx, 3xx and 4xx ones.',
      par: 4,
      match: [
        '10.0.4.17 - - "GET /api/orders HTTP/1.1" 502 157',
        '10.0.4.22 - - "POST /login HTTP/1.1" 500 0',
        '10.0.9.3 - - "GET /img/logo.png HTTP/2.0" 503 0',
        '172.16.0.5 - - "PUT /api/cart/42 HTTP/1.1" 504 568'
      ],
      skip: [
        '10.0.4.17 - - "GET /api/orders HTTP/1.1" 200 5021',
        '10.0.4.18 - - "GET /admin HTTP/1.1" 403 153',
        '10.0.9.3 - - "GET /favicon.ico HTTP/2.0" 404 555',
        '172.16.0.5 - - "PUT /api/cart/42 HTTP/1.1" 301 169',
        '10.0.5.50 - - "GET /v5/status HTTP/1.1" 429 0'
      ]
    },
    {
      id: 'cron-five',
      title: 'Every five minutes',
      source: 'crontab -l',
      task: 'Catch the jobs that run every 5 minutes. Leave every 15 or 50 minutes, minute 5 of each hour, every 5 hours and the commented-out line.',
      par: 6,
      match: [
        '*/5 * * * * /usr/local/bin/backup.sh',
        '*/5 * * * * root /opt/certbot/renew --quiet',
        '*/5 9-17 * * 1-5 /home/ops/poll-queue.sh'
      ],
      skip: [
        '*/15 * * * * /usr/local/bin/check-disk.sh',
        '*/50 * * * * /usr/bin/php /var/www/cron.php',
        '5 * * * * /usr/local/bin/hourly-backup.sh',
        '0 */5 * * * /usr/local/bin/sync-queue.sh',
        '# */5 * * * * root /opt/certbot/renew --quiet'
      ]
    },
    {
      id: 'oom-kill',
      title: 'Out of memory',
      source: 'dmesg',
      task: 'Catch the lines where the kernel killed a process for memory. Leave the warnings around the kill and the journald watchdog.',
      par: 5,
      match: [
        '[81234.115] Killed process 4113 (java) total-vm:8123456kB',
        '[81301.870] Out of memory: Killed process 977 (postgres)',
        '[82010.004] Memory cgroup out of memory: Killed process 88'
      ],
      skip: [
        '[81234.100] java invoked oom-killer: gfp_mask=0x140cca',
        '[81234.112] Out of memory: Kill process 4113 (java) score 91',
        '[81240.082] oom_reaper: reaped process 4113 (java)',
        '[81250.311] java: page allocation stalls for 10012ms',
        '[81262.018] journald: killed by watchdog, restarting'
      ]
    },
    {
      id: 'slow-requests',
      title: 'Slow lane',
      source: 'nginx log with request times',
      task: 'Catch the requests that took 1 second or more (rt= is the request time in seconds).',
      par: 7,
      match: [
        'GET /api/search 200 upstream=10.0.0.5:8080 rt=2.513',
        'POST /api/report 200 upstream=10.0.0.6:8080 rt=10.002',
        'GET /api/export 504 upstream=10.0.0.5:8080 rt=60.001',
        'GET /api/search 200 upstream=10.0.0.7:8080 rt=1.000'
      ],
      skip: [
        'GET /api/search 200 upstream=10.0.0.5:8080 rt=0.981',
        'GET /static/app.js 200 upstream=10.0.0.6:8080 rt=0.004',
        'POST /api/report 200 upstream=10.0.0.7:8080 rt=0.250',
        'GET /api/export 200 upstream=10.0.1.10:8080 rt=0.999'
      ]
    },
    {
      id: 'disk-full',
      title: 'Disk almost full',
      source: 'df -h',
      task: 'Catch the filesystems at 90% use or more.',
      par: 7,
      match: [
        '/dev/sda1   50G   46G  4.0G  92% /',
        '/dev/sdb1  1.8T  1.8T   12G 100% /srv/media',
        '/dev/nvme0n1p2  468G  421G   47G  90% /home',
        'tank/backups  3.6T  3.3T  300G  91% /tank/backups'
      ],
      skip: [
        '/dev/sda2   20G  9.5G   11G  47% /var',
        '/dev/sdc1  932G  836G   96G  89% /mnt/old',
        'tmpfs  3.9G     0  3.9G   0% /dev/shm',
        '/dev/sdd1  100G  9.0G   91G   9% /data',
        'tank/media  3.6T  1.1T  2.5T  30% /tank/media',
        '/dev/nvme1n1p1  468G  12G  456G   3% /home/vm'
      ]
    },
    {
      id: 'api-errors',
      title: 'Real errors',
      source: 'app.log',
      task: 'Catch the API errors. Leave the failing health and readiness probes and the lines that are not errors.',
      par: 7,
      match: [
        '2026-11-06T03:12:09Z ERROR GET /api/pay upstream timeout',
        '2026-11-06T03:12:44Z ERROR POST /api/refund 500 db locked',
        '2026-11-06T03:13:01Z ERROR GET /api/users/7 pool exhausted'
      ],
      skip: [
        '2026-11-06T03:12:10Z ERROR GET /healthz 503 not ready',
        '2026-11-06T03:12:11Z INFO GET /api/pay 200 41ms',
        '2026-11-06T03:12:30Z WARN GET /api/users/7 slow 2310ms',
        '2026-11-06T03:12:40Z ERROR GET /readyz 503 warming up',
        '2026-11-06T03:12:45Z INFO POST /api/refund after ERROR'
      ]
    },
    {
      id: 'json-levels',
      title: 'Structured levels',
      source: 'JSON log',
      task: 'Catch the lines whose level is error or fatal. Leave lines that only mention those words in the message.',
      par: 8,
      match: [
        '{"ts":1730860801,"level":"error","msg":"payment failed"}',
        '{"ts":1730860812,"level":"fatal","msg":"config missing"}',
        '{"ts":1730860827,"level":"error","msg":"retry 3/3"}'
      ],
      skip: [
        '{"ts":1730860803,"level":"info","msg":"no error yet"}',
        '{"ts":1730860824,"level":"warn","msg":"error budget 82%"}',
        '{"ts":1730860835,"level":"debug","msg":"fatal=false"}',
        '{"ts":1730860846,"level":"info","msg":"payment level=error"}'
      ]
    },
    {
      id: 'ssh-invalid',
      title: 'Nobody home',
      source: 'auth.log',
      task: 'Catch the login attempts for users that do not exist on this host.',
      par: 4,
      match: [
        'sshd[812]: Invalid user admin from 203.0.113.9 port 4120',
        'sshd[812]: Failed password for invalid user admin',
        'sshd[901]: Invalid user oracle from 198.51.100.4',
        'sshd[905]: Failed password for invalid user test'
      ],
      skip: [
        'sshd[733]: Failed password for root from 203.0.113.9',
        'sshd[733]: Accepted publickey for deploy from 10.0.0.2',
        'sshd[740]: Failed password for vasyl from 10.0.0.7',
        'sshd[750]: error: invalid format in authorized_keys',
        'sshd[742]: session opened for user git by (uid=0)'
      ]
    },
    {
      id: 'failed-units',
      title: 'Failed units',
      source: 'journalctl -b',
      task: 'Catch the units that failed or exited with status 1. Leave the ones that started, stopped cleanly or exited with status 0.',
      par: 5,
      match: [
        'systemd[1]: nginx.service: Failed with result exit-code.',
        'systemd[1]: backup.service: Main process exited, status=1',
        'systemd[1]: Failed to start Docker Application Container.'
      ],
      skip: [
        'systemd[1]: Started nginx.service - A high performance web',
        'systemd[1]: backup.service: Deactivated successfully.',
        'systemd[1]: Starting Daily apt upgrade and clean activities',
        'systemd[1]: app.service: Main process exited, status=0',
        'systemd[1]: Reached target Multi-User System.'
      ]
    },
    {
      id: 'pinned-images',
      title: 'Pinned images',
      source: 'docker-compose.yml',
      task: 'Catch the images pinned to a version number. Leave untagged images, :latest and :lts-alpine.',
      par: 9,
      match: [
        'image: nginx:1.27.2',
        'image: postgres:16-alpine',
        'image: ghcr.io/acme/api:2.4.1',
        'image: traefik:v3.2',
        'image: localhost:5000/app:0.9',
        'image: registry:2'
      ],
      skip: [
        'image: nginx:latest',
        'image: redis',
        'image: localhost:5000/app',
        'image: ubuntu:latest',
        'image: ghcr.io/acme/api',
        'image: node:lts-alpine'
      ]
    },
    {
      id: 'mac-address',
      title: 'Hardware addresses',
      source: 'ip link',
      task: 'Catch well-formed MAC addresses: six pairs of lowercase hex digits joined by colons.',
      par: 19,
      match: [
        '00:1a:2b:3c:4d:5e',
        'a4:83:e7:0f:12:9c',
        'f0:9f:c2:7a:00:01',
        'de:ad:be:ef:ca:fe'
      ],
      skip: [
        '00:1a:2b:3c:4d',
        '00:1a:2b:3c:4d:5e:6f',
        '00:1g:2b:3c:4d:5e',
        '001a.2b3c.4d5e',
        '0:1a:2b:3c:4d:5e',
        '00:1a:2b:3c:4d:5',
        '00-1a-2b-3c-4d-5e'
      ]
    },
    {
      id: 'low-ports',
      title: 'Low ports',
      source: 'ss -tlnp',
      task: 'Catch the sockets listening on a port below 1000. Leave higher ports and the established connection.',
      par: 12,
      match: [
        'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=711))',
        'LISTEN 0 511 0.0.0.0:80 0.0.0.0:*',
        'LISTEN 0 511 [::]:443 [::]:*',
        'LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*'
      ],
      skip: [
        'LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:*',
        'LISTEN 0 244 127.0.0.1:5432 0.0.0.0:*',
        'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:*',
        'LISTEN 0 128 [::]:1024 [::]:*',
        'ESTAB 0 0 10.0.0.5:22 10.0.0.9:51544'
      ]
    },
    {
      id: 'clock-times',
      title: 'On the clock',
      source: 'maintenance windows',
      task: 'Catch valid 24-hour times written HH:MM.',
      par: 24,
      match: ['00:00', '23:59', '09:05', '19:30', '20:45', '12:00'],
      skip: ['24:00', '12:60', '7:30', '25:10', '99:99', '23:5', '123:45', '19:30:00']
    },
    {
      id: 'release-tags',
      title: 'Release tags',
      source: 'git tag',
      task: 'Catch release tags: v, then MAJOR.MINOR.PATCH, then an optional pre-release such as -rc.1.',
      par: 22,
      match: ['v1.2.3', 'v10.0.0', 'v2.11.4-rc.1', 'v0.9.12', 'v3.0.0-beta.2'],
      skip: ['v1.2', '1.2.3', 'v1.2.3.4', 'v1.2.x', 'latest', 'v1.2.3-', 'release-2026', 'v2026']
    },
    {
      id: 'private-ipv4',
      title: 'Inside the firewall',
      source: 'firewall source addresses',
      task: 'Catch the private IPv4 addresses: 10.0.0.0/8, 172.16.0.0/12 and 192.168.0.0/16.',
      par: 40,
      match: ['10.0.0.1', '10.255.3.7', '172.16.0.9', '172.31.200.1', '192.168.1.40', '172.20.1.1'],
      skip: ['172.32.0.1', '172.15.9.9', '8.8.8.8', '192.169.0.1', '11.0.0.1', '100.64.0.1', '1.10.0.1']
    },
    {
      id: 'iso-dates',
      title: 'Calendar check',
      source: 'backup dates',
      task: 'Catch valid ISO dates written YYYY-MM-DD, with months 01-12 and days 01-31.',
      par: 38,
      match: ['2026-11-06', '1999-12-31', '2024-02-29', '2026-01-09', '2030-10-20'],
      skip: ['2026-13-01', '2026-11-32', '26-11-06', '2026/11/06', '2026-1-6', '2026-00-10', '2026-11-6', '20261106']
    },
    {
      id: 'commit-style',
      title: 'Commit style',
      source: 'git log --oneline',
      task: 'Catch subjects written type(scope): subject, with a lowercase type, an optional scope and a space after the colon.',
      par: 19,
      match: [
        'feat(api): add rate limit to /login',
        'fix: handle empty config file',
        'chore(deps): bump nginx to 1.27.2',
        'docs: explain the backup rotation'
      ],
      skip: [
        'Merge branch \'main\' into feat/limits',
        'feat add retry to the uploader',
        'Fix: typo in README',
        'fix(): empty scope',
        'fix:no space after the colon'
      ]
    },
    {
      id: 'volume-uuids',
      title: 'Volume IDs',
      source: 'blkid',
      task: 'Catch canonical UUIDs: 8-4-4-4-12 lowercase hex digits joined by dashes.',
      par: 28,
      match: [
        '3f2b8c1e-9a4d-4e7b-8f21-0c5d6e7a8b90',
        '00000000-0000-4000-8000-000000000000',
        'c0ffee00-1234-4abc-9def-abcdef012345'
      ],
      skip: [
        '3f2b8c1e-9a4d-4e7b-8f21-0c5d6e7a8b9',
        'g3f2b8c1-9a4d-4e7b-8f21-0c5d6e7a8b90',
        '3f2b8c1e9a4d4e7b8f210c5d6e7a8b90',
        '3f2b8c1e-9a4d-4e7b-8f21-0c5d6e7a8b90-1',
        '{3f2b8c1e-9a4d-4e7b-8f21-0c5d6e7a8b90}',
        '3f2b8c1e-9a4d4-e7b-8f21-0c5d6e7a8b90'
      ]
    }
  ];

  var RXP_HOLE_COUNT = RXP_HOLES.length;

  // The worker's whole program: compile the pattern, then the span of the
  // first match in every line (null where it does not match), or the
  // engine's error text.  It runs nothing but this.
  var RXP_WORKER_SOURCE = [
    'self.onmessage = function (event) {',
    '  var job = event.data;',
    '  var reply = { id: job.id, error: null, spans: [] };',
    '  try {',
    '    var re = new RegExp(job.pattern);',
    '    for (var i = 0; i < job.lines.length; i++) {',
    '      var m = re.exec(job.lines[i]);',
    '      reply.spans.push(m ? [m.index, m.index + m[0].length] : null);',
    '    }',
    '  } catch (error) {',
    '    reply.error = String(error && error.message ? error.message : error);',
    '    reply.spans = null;',
    '  }',
    '  self.postMessage(reply);',
    '};'
  ].join('\n');

  // ── State ─────────────────────────────────────────────────────────────────

  // hole: the hole on screen (0-17).  round: the round number.  drafts: the
  // pattern typed for each hole.  card: this round's strokes per hole, null
  // until holed.  best: { holes: [{ pattern, strokes } or null], course:
  // the lowest complete round total or null }.
  var rxpState = {
    hole: 0,
    round: 1,
    drafts: null,
    card: null,
    best: null
  };

  // Page handles, never saved.  mode: 'starting', 'worker' or 'main'.
  // job: the check the worker runs now ({ id, hole, pattern, lines, probe,
  // timer }); queued: the newest check waiting behind it (older ones are
  // dropped).  result: the outcome shown for the pattern on screen.
  // submit: the { hole, pattern } Enter is waiting for.  stateText /
  // bestText: the save texts this tab last read or wrote, so a save another
  // tab wrote since stands out.  failed: storage keys that could not be
  // written or read.
  var rxpRuntime = {
    els: null,
    lines: [],
    cells: [],
    mode: 'starting',
    reason: '',
    url: null,
    worker: null,
    job: null,
    queued: null,
    nextId: 1,
    result: null,
    submit: null,
    confirming: false,
    confirmTimeout: null,
    toastTimeout: null,
    stateText: null,
    bestText: null,
    failed: []
  };

  // ── Helpers (no DOM) ──────────────────────────────────────────────────────

  function rxpFill(length, value) {
    var out = [];
    for (var i = 0; i < length; i++) {
      out.push(value);
    }
    return out;
  }

  function rxpIsInteger(value) {
    return typeof value === 'number' && value % 1 === 0;
  }

  function rxpIsObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function rxpParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  function rxpPlural(count, word) {
    return count + ' ' + word + (count === 1 ? '' : 's');
  }

  // Every test line of a hole: the Catch lines, then the Leave lines.
  function rxpHoleLines(hole) {
    return hole.match.concat(hole.skip);
  }

  function rxpCoursePar() {
    var total = 0;
    RXP_HOLES.forEach(function (hole) {
      total += hole.par;
    });
    return total;
  }

  // Strokes against par as golf writes it: E, +2, -1.
  function rxpFormatToPar(toPar) {
    if (toPar === 0) {
      return 'E';
    }
    return (toPar > 0 ? '+' : '') + toPar;
  }

  // The name of a hole's score against par: birdie, bogey ...; beyond a
  // triple bogey or an albatross the number says it.
  function rxpScoreName(toPar) {
    var key = String(toPar);
    if (Object.prototype.hasOwnProperty.call(RXP_SCORE_NAMES, key)) {
      return RXP_SCORE_NAMES[key];
    }
    return toPar < 0 ? toPar + ' under par' : toPar + ' over par';
  }

  // ── Patterns (no DOM) ─────────────────────────────────────────────────────

  // The quantifier that starts at index i of pattern as { length, min, max }
  // (max Infinity for none), or null: *, +, ?, {n}, {n,} or {n,m}, with an
  // optional lazy ? after it.  A { that starts no {n,m} is a plain
  // character, as in a regular expression without the u flag.
  function rxpQuantifierAt(pattern, i) {
    var c = pattern.charAt(i);
    var min;
    var max;
    var length = 1;
    if (c === '*' || c === '+') {
      min = c === '*' ? 0 : 1;
      max = Infinity;
    } else if (c === '?') {
      min = 0;
      max = 1;
    } else {
      var m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
      if (!m) {
        return null;
      }
      min = Number(m[1]);
      max = m[2] === undefined ? min : (m[3] === '' ? Infinity : Number(m[3]));
      length = m[0].length;
    }
    if (pattern.charAt(i + length) === '?') {
      length++;
    }
    return { length: length, min: min, max: max };
  }

  // The index just past the character class that opens at index i.
  function rxpClassEnd(pattern, i) {
    var j = i + 1;
    while (j < pattern.length) {
      var c = pattern.charAt(j);
      if (c === '\\') {
        j += 2;
      } else if (c === ']') {
        return j + 1;
      } else {
        j++;
      }
    }
    return pattern.length;
  }

  // How the group that opens at index i of pattern starts, as { length,
  // look }: ( (?: (?<name> and modifier groups such as (?i: match text, the
  // lookarounds (?= (?! (?<= (?<! only test it.
  function rxpGroupOpening(pattern, i) {
    if (pattern.charAt(i + 1) !== '?') {
      return { length: 1, look: false };
    }
    var c = pattern.charAt(i + 2);
    var next = pattern.charAt(i + 3);
    if (c === '=' || c === '!') {
      return { length: 3, look: true };
    }
    if (c === '<' && (next === '=' || next === '!')) {
      return { length: 4, look: true };
    }
    var close = pattern.indexOf(c === '<' ? '>' : ':', i);
    return { length: close === -1 ? pattern.length - i : close - i + 1, look: false };
  }

  // What follows \0, \x, \u and \c in an escape of one character.
  var RXP_ESCAPE_TAILS = { '0': /^[0-7]{0,2}/, x: /^[\da-fA-F]{2}/, u: /^[\da-fA-F]{4}/, c: /^[a-zA-Z]/ };

  // The syntax tree of a pattern that compiles, for rxpBacktrack: nodes
  // { type, start, end } of type 'char' (one character: a literal, ., an
  // escape or a class), 'assert' (^ $ \b \B), 'backref' (\1, \k<name>),
  // 'group' and 'look' (with content), 'seq' (items), 'alt' (branches) and
  // 'quant' (atom, min, max).
  function rxpParse(pattern) {
    var i = 0;

    function parseEscape(start) {
      var c = pattern.charAt(i + 1);
      var type = 'char';
      i += 2;
      if (c === 'b' || c === 'B') {
        type = 'assert';
      } else if (c >= '1' && c <= '9') {
        type = 'backref';
        while (pattern.charAt(i) >= '0' && pattern.charAt(i) <= '9') {
          i++;
        }
      } else if (c === 'k' && pattern.charAt(i) === '<' && pattern.indexOf('>', i) !== -1) {
        type = 'backref';
        i = pattern.indexOf('>', i) + 1;
      } else if (RXP_ESCAPE_TAILS[c]) {
        var tail = RXP_ESCAPE_TAILS[c].exec(pattern.slice(i));
        i += tail ? tail[0].length : 0;
      }
      return { type: type, start: start, end: i };
    }

    function parseAtom() {
      var start = i;
      var c = pattern.charAt(i);
      if (c === '(') {
        var open = rxpGroupOpening(pattern, i);
        i += open.length;
        var content = parseAlt();
        i++;
        return { type: open.look ? 'look' : 'group', content: content, start: start, end: i };
      }
      if (c === '\\') {
        return parseEscape(start);
      }
      i = c === '[' ? rxpClassEnd(pattern, i) : i + 1;
      return { type: c === '^' || c === '$' ? 'assert' : 'char', start: start, end: i };
    }

    function parseTerm() {
      var atom = parseAtom();
      var q = rxpQuantifierAt(pattern, i);
      if (!q) {
        return atom;
      }
      i += q.length;
      return { type: 'quant', atom: atom, min: q.min, max: q.max, start: atom.start, end: i };
    }

    function parseSeq() {
      var start = i;
      var items = [];
      while (i < pattern.length && pattern.charAt(i) !== '|' && pattern.charAt(i) !== ')') {
        items.push(parseTerm());
      }
      return { type: 'seq', items: items, start: start, end: i };
    }

    function parseAlt() {
      var start = i;
      var branches = [parseSeq()];
      while (pattern.charAt(i) === '|') {
        i++;
        branches.push(parseSeq());
      }
      return branches.length === 1 ? branches[0] : { type: 'alt', branches: branches, start: start, end: i };
    }

    return parseAlt();
  }

  // Whether node holds a quantifier or a back reference at any depth.
  function rxpHasRepeat(node) {
    if (node.type === 'quant' || node.type === 'backref') {
      return true;
    }
    var kids = node.items || node.branches || (node.content ? [node.content] : []);
    return kids.some(rxpHasRepeat);
  }

  // Counts over a line of RXP_MAIN_LINE characters: entry n is for n
  // characters taken (ways) or left to take (work).
  function rxpVector(value) {
    return rxpFill(RXP_MAIN_LINE + 1, value);
  }

  function rxpUnit(n) {
    var v = rxpVector(0);
    v[n] = 1;
    return v;
  }

  function rxpPlusOne(v) {
    return v.map(function (x) {
      return x + 1;
    });
  }

  function rxpAddInto(target, v) {
    for (var i = 0; i < target.length; i++) {
      target[i] += v[i];
    }
  }

  function rxpAny(v) {
    return v.some(function (x) {
      return x > 0;
    });
  }

  // out[n] = the sum of a[i] * b[n - i], cut at the line length.
  function rxpConvolve(a, b) {
    var out = rxpVector(0);
    for (var i = 0; i < a.length; i++) {
      if (!a[i]) {
        continue;
      }
      for (var j = 0; i + j < out.length; j++) {
        out[i + j] += a[i] * b[j];
      }
    }
    return out;
  }

  // The most steps a backtracking engine can take to give up on a line of
  // RXP_MAIN_LINE characters, trying every start, when every character
  // matches every atom: { steps, part, why }.  For every node it counts the
  // ways (ways[n]: to match n characters) and the work (work[r]: the steps
  // with r characters left).  A back reference matches one text, empty or
  // not; since a shorter match leaves more line to the rest, it counts as
  // nothing or one character.  An atom is one step, so is every repeat a
  // quantifier tries and every alternative; a repeat past the minimum that
  // matches nothing fails, as the standard says.  A pattern that starts
  // with ^ in every alternative runs from the first character only.  The
  // count stops at the first node over RXP_MAIN_STEPS: part is its text and
  // why its kind ('nested', 'alternatives', 'chain', 'branches', or 'empty'
  // for a part that can match nothing repeated more than RXP_MAIN_LINE
  // times); both are null for a pattern within the limit.  Tests compare it
  // with a backtracking matcher that counts its steps.
  function rxpBacktrack(pattern) {
    var size = RXP_MAIN_LINE;
    var root = rxpParse(pattern);
    var branches = root.type === 'alt' ? root.branches : [root];
    var anchored = branches.every(function (branch) {
      var first = branch.items[0];
      return !!first && first.type === 'assert' && pattern.charAt(first.start) === '^';
    });
    var out = { steps: 0, part: null, why: null };

    function cost(work) {
      if (anchored) {
        return work[size] + size * branches.length;
      }
      return work.reduce(function (sum, x) {
        return sum + x;
      }, 0);
    }

    // Records the part from start to end as the one at fault when work is
    // over the limit.
    function over(start, end, work, why) {
      out.steps = cost(work);
      if (out.steps <= RXP_MAIN_STEPS) {
        return false;
      }
      out.part = pattern.slice(start, end);
      out.why = why;
      return true;
    }

    function measureSeq(node) {
      var ways = rxpUnit(0);
      var work = rxpVector(0);
      for (var k = 0; k < node.items.length; k++) {
        var item = measure(node.items[k]);
        if (!item) {
          return null;
        }
        rxpAddInto(work, rxpConvolve(ways, item.work));
        ways = rxpConvolve(ways, item.ways);
        if (over(node.start, node.items[k].end, work, 'chain')) {
          return null;
        }
      }
      return { ways: ways, work: work };
    }

    function measureAlt(node) {
      var ways = rxpVector(0);
      var work = rxpVector(0);
      for (var k = 0; k < node.branches.length; k++) {
        var branch = measure(node.branches[k]);
        if (!branch) {
          return null;
        }
        rxpAddInto(ways, branch.ways);
        rxpAddInto(work, rxpPlusOne(branch.work));
      }
      return over(node.start, node.end, work, 'branches') ? null : { ways: ways, work: work };
    }

    function measureQuant(node) {
      var atom = measure(node.atom);
      if (!atom) {
        return null;
      }
      if (node.min > size && atom.ways[0]) {
        out.steps = Infinity;
        out.part = pattern.slice(node.start, node.end);
        out.why = 'empty';
        return null;
      }
      var why = rxpHasRepeat(node.atom) ? 'nested' : 'alternatives';
      var step = rxpPlusOne(atom.work);
      var more = atom.ways.slice();
      more[0] = 0;
      var ways = rxpUnit(0);
      var work = rxpVector(0);
      var count = 0;
      for (; count < node.min && rxpAny(ways); count++) {
        rxpAddInto(work, rxpConvolve(ways, step));
        ways = rxpConvolve(ways, atom.ways);
        if (over(node.start, node.end, work, why)) {
          return null;
        }
      }
      var total = ways.slice();
      for (; count < node.max && rxpAny(ways); count++) {
        rxpAddInto(work, rxpConvolve(ways, step));
        ways = rxpConvolve(ways, more);
        rxpAddInto(total, ways);
        if (over(node.start, node.end, work, why)) {
          return null;
        }
      }
      return { ways: total, work: work };
    }

    function measure(node) {
      var type = node.type;
      if (type === 'char') {
        return { ways: rxpUnit(1), work: rxpVector(1) };
      }
      if (type === 'assert') {
        return { ways: rxpUnit(0), work: rxpVector(1) };
      }
      if (type === 'backref') {
        var either = rxpUnit(0);
        either[1] = 1;
        return { ways: either, work: rxpVector(1) };
      }
      if (type === 'group') {
        return measure(node.content);
      }
      if (type === 'look') {
        var inner = measure(node.content);
        return inner ? { ways: rxpUnit(0), work: rxpPlusOne(inner.work) } : null;
      }
      if (type === 'seq') {
        return measureSeq(node);
      }
      return type === 'alt' ? measureAlt(node) : measureQuant(node);
    }

    var result = measure(root);
    if (result) {
      out.steps = cost(result.work);
    }
    return out;
  }

  // 1500000 as 1,500,000.
  function rxpThousands(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  var RXP_RISK_WHY = {
    nested: 'repeats a group that holds a quantifier of its own, a nested quantifier like (a+)+',
    alternatives: 'repeats a group that holds alternatives (|), like (a|a)*',
    chain: 'chains quantifiers that can take the same characters, like .*.*.*.* or (.?){20}',
    branches: 'has alternatives that together try too many ways, like .*.*.*|.*.*.*'
  };

  // The static check of main-thread mode: why pattern (one that compiles)
  // can backtrack for a runaway time, or null.  rxpBacktrack counts the
  // steps; a pattern over RXP_MAIN_STEPS is refused with the part at fault.
  function rxpIsRisky(pattern) {
    var count = rxpBacktrack(pattern);
    if (!count.why) {
      return null;
    }
    if (count.why === 'empty') {
      return 'Refused in main-thread mode: "' + count.part + '" repeats a part that can match nothing more than ' +
        RXP_MAIN_LINE + ' times. The engine runs every one of those repeats, and only a Web Worker could stop it.';
    }
    return 'Refused in main-thread mode: "' + count.part + '" ' + RXP_RISK_WHY[count.why] + '. On a line that almost ' +
      'matches, the engine could take ' + rxpThousands(count.steps) + ' steps or more to give up, and main-thread mode ' +
      'takes up to ' + rxpThousands(RXP_MAIN_STEPS) + ' a line, since only a Web Worker could stop a check that runs too long.';
  }

  // Why a pattern is too long for the mode (strict: main-thread mode), or
  // null.
  function rxpTooLong(pattern, strict) {
    var limit = strict ? RXP_MAIN_PATTERN : RXP_MAX_PATTERN;
    if (pattern.length <= limit) {
      return null;
    }
    return 'The pattern is ' + pattern.length + ' characters long: ' +
      (strict ? 'main-thread mode takes up to ' : 'the game takes up to ') + limit + '.';
  }

  // Compiles pattern without running it, as { re, error }: error is the
  // length limit, the engine's own message ('Invalid regular expression:
  // /(/: Unterminated group'), or in strict (main-thread) mode the static
  // check's refusal.
  function rxpCompileSafe(pattern, strict) {
    var error = rxpTooLong(pattern, strict);
    if (error) {
      return { re: null, error: error };
    }
    var re;
    try {
      re = new RegExp(pattern);
    } catch (compileError) {
      return { re: null, error: compileError.message };
    }
    error = strict ? rxpIsRisky(pattern) : null;
    return error ? { re: null, error: error } : { re: re, error: null };
  }

  // The span [start, end] of the first match of re in every line, null
  // where it does not match (what the worker sends back too).
  function rxpExecSpans(re, lines) {
    return lines.map(function (line) {
      var m = re.exec(line);
      return m ? [m.index, m.index + m[0].length] : null;
    });
  }

  // A check on the main thread, as { error, spans }: lines longer than
  // RXP_MAIN_LINE and patterns compileSafe refuses never run.
  function rxpRunMain(pattern, lines) {
    var long = lines.filter(function (line) {
      return line.length > RXP_MAIN_LINE;
    });
    if (long.length) {
      return {
        error: 'A test line is ' + long[0].length + ' characters long: main-thread mode tests lines up to ' +
          RXP_MAIN_LINE + ' ("' + long[0].slice(0, 24) + '...").',
        spans: null
      };
    }
    var compiled = rxpCompileSafe(pattern, true);
    return compiled.re ? { error: null, spans: rxpExecSpans(compiled.re, lines) } : { error: compiled.error, spans: null };
  }

  // A worker's reply as { error, spans }, checked field by field against
  // the lines it was sent: anything else is an error of its own.
  function rxpReadReply(data, lines) {
    var bad = { error: 'The worker sent back a reply the game cannot read. Type the pattern again.', spans: null };
    if (typeof data.error === 'string') {
      return { error: data.error, spans: null };
    }
    if (!Array.isArray(data.spans) || data.spans.length !== lines.length) {
      return bad;
    }
    var spans = [];
    for (var i = 0; i < lines.length; i++) {
      var span = data.spans[i];
      if (span === null) {
        spans.push(null);
      } else if (Array.isArray(span) && span.length === 2 && rxpIsInteger(span[0]) && rxpIsInteger(span[1]) &&
        span[0] >= 0 && span[1] >= span[0] && span[1] <= lines[i].length) {
        spans.push([span[0], span[1]]);
      } else {
        return bad;
      }
    }
    return { error: null, spans: spans };
  }

  // A hole scored from the spans of its lines: { solved, missed (Catch
  // lines not caught), extra (Leave lines caught), strokes, toPar }.
  function rxpScoreHole(hole, spans, pattern) {
    var count = hole.match.length;
    var missed = hole.match.filter(function (line, i) {
      return !spans[i];
    });
    var extra = hole.skip.filter(function (line, i) {
      return !!spans[count + i];
    });
    return {
      solved: missed.length === 0 && extra.length === 0,
      missed: missed,
      extra: extra,
      strokes: pattern.length,
      toPar: pattern.length - hole.par
    };
  }

  // A card's totals: { holed, strokes, par (of the holed holes), toPar,
  // complete }.
  function rxpCourseTotal(card) {
    var total = { holed: 0, strokes: 0, par: 0, toPar: 0, complete: false };
    card.forEach(function (strokes, i) {
      if (strokes !== null) {
        total.holed++;
        total.strokes += strokes;
        total.par += RXP_HOLES[i].par;
      }
    });
    total.toPar = total.strokes - total.par;
    total.complete = total.holed === RXP_HOLE_COUNT;
    return total;
  }

  // ── Saves (no DOM) ────────────────────────────────────────────────────────

  function rxpIsStrokes(value) {
    return rxpIsInteger(value) && value >= 1 && value <= RXP_MAX_PATTERN;
  }

  // The entry at index i of a saved list, or undefined.
  function rxpEntry(list, i) {
    return Array.isArray(list) ? list[i] : undefined;
  }

  // rxp-state as { hole, round, drafts, card }, each field and each entry
  // on its own: a draft that is not a string of at most RXP_MAX_PATTERN
  // characters is empty, a card entry that is not a stroke count is not
  // holed.
  function rxpParseState(text) {
    var data = rxpParseJson(text);
    if (!rxpIsObject(data)) {
      data = {};
    }
    var drafts = [];
    var card = [];
    for (var i = 0; i < RXP_HOLE_COUNT; i++) {
      var draft = rxpEntry(data.drafts, i);
      var strokes = rxpEntry(data.card, i);
      drafts.push(typeof draft === 'string' && draft.length <= RXP_MAX_PATTERN ? draft : '');
      card.push(rxpIsStrokes(strokes) ? strokes : null);
    }
    return {
      hole: rxpIsInteger(data.hole) && data.hole >= 0 && data.hole < RXP_HOLE_COUNT ? data.hole : 0,
      round: rxpIsInteger(data.round) && data.round >= 1 ? data.round : 1,
      drafts: drafts,
      card: card
    };
  }

  // rxp-best as { holes, course }: a hole's best is { pattern, strokes }
  // when the pattern is a non-empty string as long as its strokes, else
  // null; course is a whole round's strokes (at least one a hole) or null.
  function rxpParseBest(text) {
    var data = rxpParseJson(text);
    if (!rxpIsObject(data)) {
      data = {};
    }
    var holes = [];
    for (var i = 0; i < RXP_HOLE_COUNT; i++) {
      var entry = rxpEntry(data.holes, i);
      var ok = rxpIsObject(entry) && typeof entry.pattern === 'string' && rxpIsStrokes(entry.strokes) &&
        entry.pattern.length === entry.strokes;
      holes.push(ok ? { pattern: entry.pattern, strokes: entry.strokes } : null);
    }
    var course = data.course;
    return {
      holes: holes,
      course: rxpIsInteger(course) && course >= RXP_HOLE_COUNT ? course : null
    };
  }

  // Another tab's rxp-state (stored) merged into this tab's (ours): a newer
  // round wins as a whole; in the same round a hole on either card stays on
  // it (ours first) and the stored drafts are taken, except the draft of
  // hole keep (the one this tab is about to write; null for none).  The
  // hole on screen is always ours.
  function rxpMergeState(stored, ours, keep) {
    var same = stored.round === ours.round;
    var base = stored.round > ours.round ? stored : ours;
    var merged = { hole: ours.hole, round: base.round, drafts: [], card: [] };
    for (var i = 0; i < RXP_HOLE_COUNT; i++) {
      merged.card.push(same && ours.card[i] === null ? stored.card[i] : base.card[i]);
      merged.drafts.push(i === keep ? ours.drafts[i] : (same ? stored.drafts[i] : base.drafts[i]));
    }
    return merged;
  }

  // Two rxp-best records merged: the shorter pattern of each hole (a's on a
  // tie) and the lower round total.
  function rxpMergeBest(a, b) {
    var holes = a.holes.map(function (entry, i) {
      var other = b.holes[i];
      return other && (!entry || other.strokes < entry.strokes) ? other : entry;
    });
    var course = a.course;
    if (b.course !== null && (course === null || b.course < course)) {
      course = b.course;
    }
    return { holes: holes, course: course };
  }

  function rxpSerializeState() {
    return JSON.stringify({
      v: RXP_SAVE_VERSION,
      hole: rxpState.hole,
      round: rxpState.round,
      drafts: rxpState.drafts,
      card: rxpState.card
    });
  }

  function rxpSerializeBest() {
    return JSON.stringify({
      v: RXP_SAVE_VERSION,
      holes: rxpState.best.holes,
      course: rxpState.best.course
    });
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  // Names every key that failed so far in one short warning.
  function rxpWarnStorage(key, error) {
    var failed = rxpRuntime.failed;
    if (failed.indexOf(key) === -1) {
      failed.push(key);
    }
    var warning = rxpRuntime.els.warning;
    warning.textContent = 'Storage is blocked or full (' + error.name + '): ' + failed.join(' and ') +
      (failed.length === 1 ? ' is' : ' are') + ' not saved, so a reload starts over. The game itself goes on.';
    warning.classList.remove('rxp-hidden');
  }

  function rxpStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      rxpWarnStorage(key, error);
      return null;
    }
  }

  // Returns whether value was written.
  function rxpStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      rxpWarnStorage(key, error);
      return false;
    }
  }

  function rxpApplyState(saved) {
    rxpState.round = saved.round;
    rxpState.drafts = saved.drafts;
    rxpState.card = saved.card;
  }

  // Reads rxp-state again and merges what another tab stored there since
  // (rxpMergeState, keeping this tab's draft of hole keep).  Returns
  // whether anything came in.
  function rxpSyncState(keep) {
    var text = rxpStorageGet(RXP_STATE_KEY);
    if (text === rxpRuntime.stateText) {
      return false;
    }
    rxpRuntime.stateText = text;
    var merged = rxpMergeState(rxpParseState(text), rxpState, keep);
    var changed = JSON.stringify(merged) !== JSON.stringify({
      hole: rxpState.hole, round: rxpState.round, drafts: rxpState.drafts, card: rxpState.card
    });
    rxpApplyState(merged);
    return changed;
  }

  // Writes rxp-state after merging what another tab stored.  A write that
  // fails leaves stateText at what storage holds, so the next read does not
  // take the older text for another tab's.
  function rxpSaveState() {
    rxpSyncState(rxpState.hole);
    var text = rxpSerializeState();
    if (rxpStorageSet(RXP_STATE_KEY, text)) {
      rxpRuntime.stateText = text;
    }
  }

  // Reads rxp-best again and merges what another tab stored since.
  // Returns whether a best came in.
  function rxpSyncBest() {
    var text = rxpStorageGet(RXP_BEST_KEY);
    if (text === rxpRuntime.bestText) {
      return false;
    }
    rxpRuntime.bestText = text;
    var before = JSON.stringify(rxpState.best);
    rxpState.best = rxpMergeBest(rxpState.best, rxpParseBest(text));
    return JSON.stringify(rxpState.best) !== before;
  }

  // Writes rxp-best; rxpSyncBest has merged the stored one just before.
  function rxpSaveBest() {
    var text = rxpSerializeBest();
    if (rxpStorageSet(RXP_BEST_KEY, text)) {
      rxpRuntime.bestText = text;
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function rxpCurrentHole() {
    return RXP_HOLES[rxpState.hole];
  }

  function rxpDraft() {
    return rxpState.drafts[rxpState.hole];
  }

  function rxpMakeEl(tag, className, text) {
    var el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) {
      el.textContent = text;
    }
    return el;
  }

  function rxpBuildChips() {
    var box = rxpRuntime.els.chips;
    RXP_CHIPS.forEach(function (chip, i) {
      var button = rxpMakeEl('button', 'rxp-chip', chip[0]);
      button.setAttribute('type', 'button');
      button.setAttribute('data-chip', String(i));
      button.setAttribute('aria-label', 'Insert ' + chip[0]);
      box.appendChild(button);
    });
  }

  function rxpBuildCard() {
    var box = rxpRuntime.els.card;
    rxpRuntime.cells = RXP_HOLES.map(function (hole, i) {
      var cell = rxpMakeEl('button', 'rxp-card-cell');
      cell.setAttribute('type', 'button');
      cell.setAttribute('data-hole', String(i));
      var num = rxpMakeEl('span', 'rxp-card-num', String(i + 1));
      var score = rxpMakeEl('span', 'rxp-card-score', '');
      cell.appendChild(num);
      cell.appendChild(score);
      box.appendChild(cell);
      return { cell: cell, score: score };
    });
  }

  // The Catch and Leave lists of the hole on screen, built once per hole.
  function rxpBuildLines() {
    var els = rxpRuntime.els;
    var hole = rxpCurrentHole();
    els.matchList.textContent = '';
    els.skipList.textContent = '';
    rxpRuntime.lines = rxpHoleLines(hole).map(function (text, i) {
      var want = i < hole.match.length;
      var li = rxpMakeEl('li', 'rxp-line');
      var parts = {
        li: li,
        text: text,
        want: want,
        mark: rxpMakeEl('span', 'rxp-line-mark', '·'),
        pre: rxpMakeEl('span', 'rxp-line-text', text),
        hit: rxpMakeEl('span', 'rxp-hit', ''),
        post: rxpMakeEl('span', 'rxp-line-text', '')
      };
      parts.mark.setAttribute('aria-hidden', 'true');
      li.appendChild(parts.mark);
      li.appendChild(parts.pre);
      li.appendChild(parts.hit);
      li.appendChild(parts.post);
      (want ? els.matchList : els.skipList).appendChild(li);
      return parts;
    });
  }

  // The result for the pattern on screen, or null while none is in.
  function rxpShownResult() {
    var result = rxpRuntime.result;
    return result && result.hole === rxpState.hole && result.pattern === rxpDraft() ? result : null;
  }

  function rxpDrawLines(spans) {
    rxpRuntime.lines.forEach(function (line, i) {
      var span = spans ? spans[i] : null;
      var caught = !!span;
      var good = caught === line.want;
      var look = spans ? (good ? ' rxp-line--ok' : ' rxp-line--bad') : '';
      line.li.className = 'rxp-line' + look;
      line.mark.textContent = spans ? (good ? '✓' : '✗') : '·';
      line.pre.textContent = caught ? line.text.slice(0, span[0]) : line.text;
      line.hit.textContent = caught ? line.text.slice(span[0], span[1]) : '';
      line.hit.className = 'rxp-hit' + (caught && span[0] === span[1] ? ' rxp-hit--empty' : '');
      line.post.textContent = caught ? line.text.slice(span[1]) : '';
      var verdict = spans ? (line.want ? (caught ? 'caught' : 'missed') : (caught ? 'caught by mistake' : 'left alone')) :
        (line.want ? 'to catch' : 'to leave');
      line.li.setAttribute('aria-label', verdict + ': ' + line.text);
    });
  }

  function rxpStatusText(result, score) {
    if (!rxpDraft()) {
      return 'Type a pattern: it has to catch every line under Catch and none under Leave. Every character is a stroke.';
    }
    if (!result) {
      return 'Checking /' + rxpDraft() + '/ ...';
    }
    if (result.error) {
      return result.error;
    }
    var hole = rxpCurrentHole();
    if (score.solved) {
      var onCard = rxpState.card[rxpState.hole];
      return 'All ' + (hole.match.length + hole.skip.length) + ' lines pass in ' + rxpPlural(score.strokes, 'stroke') +
        ' (' + rxpFormatToPar(score.toPar) + ', ' + rxpScoreName(score.toPar) + '). ' +
        (onCard === null ? 'Press Enter or Hole out to score it.' :
          'On this round\'s card with ' + rxpPlural(onCard, 'stroke') + '; holing out again can still set a best.');
    }
    var caught = hole.match.length - score.missed.length;
    return 'Caught ' + caught + ' of ' + rxpPlural(hole.match.length, 'line') + ' to catch' +
      (score.extra.length ? '; ' + score.extra.length + ' of ' + hole.skip.length + ' lines to leave are caught too.' : '.');
  }

  // The short count beside the pattern box, in sight with a phone keyboard
  // open: '4/4 caught, 1/5 wrong'.
  function rxpLiveText(result, score, pending) {
    if (pending) {
      return 'checking...';
    }
    if (!result) {
      return '';
    }
    if (!score) {
      return 'error: see below';
    }
    var hole = rxpCurrentHole();
    return (hole.match.length - score.missed.length) + '/' + hole.match.length + ' caught, ' + score.extra.length +
      '/' + hole.skip.length + ' wrong';
  }

  // The lists, the counts and the status for the pattern on screen.  While
  // the pattern's check is still out (the worker answers within
  // RXP_TIMEOUT_MS), the lines keep their last colours, dimmed, and the
  // status and counts say a check is running.
  function rxpRenderResult() {
    var els = rxpRuntime.els;
    var hole = rxpCurrentHole();
    var result = rxpShownResult();
    var pending = !result && !!rxpDraft();
    var spans = result && !result.error ? result.spans : null;
    var score = spans ? rxpScoreHole(hole, spans, result.pattern) : null;
    var listLook = pending ? 'rxp-list rxp-list--pending' : 'rxp-list';
    els.matchList.className = listLook;
    els.skipList.className = listLook;
    if (pending) {
      els.matchCount.textContent = 'checking...';
      els.skipCount.textContent = 'checking...';
    } else {
      rxpDrawLines(spans);
      els.matchCount.textContent = score ? (hole.match.length - score.missed.length) + ' of ' + hole.match.length +
        ' caught' : rxpPlural(hole.match.length, 'line');
      els.skipCount.textContent = score ? (hole.skip.length - score.extra.length) + ' of ' + hole.skip.length +
        ' left alone' : rxpPlural(hole.skip.length, 'line');
    }
    els.status.textContent = rxpStatusText(result, score);
    var look = '';
    if (result && result.error) {
      look = '--error';
    } else if (score && score.solved) {
      look = '--solved';
    }
    els.status.className = 'rxp-status' + (look ? ' rxp-status' + look : '');
    els.live.textContent = rxpLiveText(result, score, pending);
    els.live.className = 'rxp-live' + (look ? ' rxp-live' + look : '');
  }

  function rxpRenderStrokes() {
    var els = rxpRuntime.els;
    var hole = rxpCurrentHole();
    var strokes = rxpDraft().length;
    els.strokes.textContent = rxpPlural(strokes, 'stroke');
    els.score.textContent = strokes ? rxpFormatToPar(strokes - hole.par) + ' ' + rxpScoreName(strokes - hole.par) : '';
  }

  function rxpBestText(entry, par) {
    if (!entry) {
      return 'Best: --';
    }
    return 'Best: /' + entry.pattern + '/ in ' + rxpPlural(entry.strokes, 'stroke') + ' (' +
      rxpFormatToPar(entry.strokes - par) + ', ' + rxpScoreName(entry.strokes - par) + ')';
  }

  function rxpRenderCard() {
    var els = rxpRuntime.els;
    rxpRuntime.cells.forEach(function (parts, i) {
      var strokes = rxpState.card[i];
      var par = RXP_HOLES[i].par;
      var look = '';
      if (strokes !== null) {
        look = strokes < par ? ' rxp-card-cell--under' : (strokes > par ? ' rxp-card-cell--over' : ' rxp-card-cell--par');
      }
      var current = i === rxpState.hole;
      parts.cell.className = 'rxp-card-cell' + look + (current ? ' rxp-card-cell--current' : '');
      parts.score.textContent = strokes === null ? '·' : rxpFormatToPar(strokes - par);
      parts.cell.setAttribute('aria-label', 'Hole ' + (i + 1) + ', par ' + par + ': ' +
        (strokes === null ? 'not holed' : rxpPlural(strokes, 'stroke') + ', ' + rxpFormatToPar(strokes - par)));
      if (current) {
        parts.cell.setAttribute('aria-current', 'step');
      } else {
        parts.cell.removeAttribute('aria-current');
      }
    });
    var total = rxpCourseTotal(rxpState.card);
    var coursePar = rxpCoursePar();
    if (total.complete) {
      els.course.textContent = 'Round ' + rxpState.round + ' complete: ' + total.strokes + ' strokes (' +
        rxpFormatToPar(total.toPar) + ', par ' + coursePar + ').';
    } else if (total.holed) {
      els.course.textContent = 'Round ' + rxpState.round + ': ' + total.holed + ' of ' + RXP_HOLE_COUNT + ' holed, ' +
        total.strokes + ' strokes (' + rxpFormatToPar(total.toPar) + ').';
    } else {
      els.course.textContent = 'Round ' + rxpState.round + ': no hole holed yet. Course par ' + coursePar + '.';
    }
    var course = rxpState.best.course;
    els.bestCourse.textContent = course === null ? 'Best round: --' :
      'Best round: ' + course + ' strokes (' + rxpFormatToPar(course - coursePar) + ')';
  }

  function rxpRenderSandbox() {
    var els = rxpRuntime.els;
    var mode = rxpRuntime.mode;
    if (mode === 'starting') {
      els.sandbox.textContent = 'Sandbox: starting the Web Worker...';
    } else if (mode === 'worker') {
      els.sandbox.textContent = 'Sandbox: Web Worker. A check that runs longer than ' + RXP_TIMEOUT_MS +
        ' ms is stopped, so no pattern can freeze the page.';
    } else {
      els.sandbox.textContent = 'Sandbox: main thread, because the Web Worker is unavailable (' + rxpRuntime.reason +
        '). Patterns up to ' + RXP_MAIN_PATTERN + ' characters; one that could take more than ' +
        rxpThousands(RXP_MAIN_STEPS) + ' steps on a line, such as (a+)+, (a|a)* or (.?){20}, is refused before it runs.';
    }
    els.sandbox.className = 'rxp-sandbox rxp-sandbox--' + mode;
  }

  function rxpRender() {
    var els = rxpRuntime.els;
    var hole = rxpCurrentHole();
    els.holeNumber.textContent = 'Hole ' + (rxpState.hole + 1) + ' of ' + RXP_HOLE_COUNT;
    els.holeTitle.textContent = hole.title;
    els.holeSource.textContent = hole.source;
    els.holeTask.textContent = hole.task;
    els.par.textContent = 'Par ' + hole.par;
    els.bestHole.textContent = rxpBestText(rxpState.best.holes[rxpState.hole], hole.par);
    els.prev.disabled = rxpState.hole === 0;
    els.next.disabled = rxpState.hole === RXP_HOLE_COUNT - 1;
    rxpRenderStrokes();
    rxpRenderCard();
    rxpRenderResult();
  }

  function rxpHideToast() {
    rxpRuntime.toastTimeout = null;
    rxpRuntime.els.toast.classList.remove('rxp-show');
  }

  // Shows message for RXP_TOAST_MS; a newer toast gets its full time.  kind:
  // undefined for a holed hole (green), 'error' for a refusal or a miss
  // (red), 'info' for anything else (blue).
  function rxpShowToast(message, kind) {
    var toast = rxpRuntime.els.toast;
    clearTimeout(rxpRuntime.toastTimeout);
    toast.textContent = message;
    toast.className = 'rxp-toast rxp-show' + (kind ? ' rxp-toast--' + kind : '');
    rxpRuntime.toastTimeout = setTimeout(rxpHideToast, RXP_TOAST_MS);
  }

  // ── Sandbox ───────────────────────────────────────────────────────────────

  // Takes a check's outcome ({ error, spans, timedOut }): shows it when it
  // is for the pattern on screen, and scores it when Enter waits for it.
  function rxpFinish(job, outcome) {
    var result = { hole: job.hole, pattern: job.pattern, error: outcome.error, spans: outcome.spans };
    var submit = rxpRuntime.submit;
    if (result.hole === rxpState.hole && result.pattern === rxpDraft()) {
      rxpRuntime.result = result;
      rxpRenderResult();
    }
    if (submit && submit.hole === result.hole && submit.pattern === result.pattern) {
      rxpRuntime.submit = null;
      rxpCompleteSubmit(result);
    }
  }

  // Main-thread mode from now on, saying why.  The check that waited for
  // the worker runs here instead (the newest one; an older one in flight is
  // stale).
  function rxpUseMain(reason) {
    var job = rxpRuntime.job;
    var pending = rxpRuntime.queued || (job && !job.probe ? job : null);
    if (job) {
      clearTimeout(job.timer);
    }
    if (rxpRuntime.worker) {
      rxpRuntime.worker.terminate();
    }
    rxpRuntime.worker = null;
    rxpRuntime.job = null;
    rxpRuntime.queued = null;
    rxpRuntime.mode = 'main';
    rxpRuntime.reason = reason;
    rxpRenderSandbox();
    if (pending) {
      rxpFinish(pending, rxpRunMain(pending.pattern, pending.lines));
    }
  }

  // Starts a worker from the Blob of RXP_WORKER_SOURCE (made once).
  // Returns whether it started; if the page refuses, main-thread mode.
  function rxpSpawn() {
    var worker;
    try {
      if (!rxpRuntime.url) {
        rxpRuntime.url = URL.createObjectURL(new Blob([RXP_WORKER_SOURCE], { type: 'text/javascript' }));
      }
      worker = new Worker(rxpRuntime.url);
    } catch (error) {
      rxpUseMain('the page does not allow it: ' + error.name + ': ' + error.message);
      return false;
    }
    worker.addEventListener('message', rxpHandleWorkerMessage);
    worker.addEventListener('error', rxpHandleWorkerError);
    rxpRuntime.worker = worker;
    return true;
  }

  // Sends a check to the worker, with the clock that stops it.  The test
  // pattern of a new worker gets RXP_PROBE_MS, since a slow phone needs a
  // while to start a worker at all.
  function rxpPost(job) {
    job.id = rxpRuntime.nextId++;
    job.timer = setTimeout(rxpHandleTimeout, job.probe ? RXP_PROBE_MS : RXP_TIMEOUT_MS);
    rxpRuntime.job = job;
    rxpRuntime.worker.postMessage({ id: job.id, pattern: job.pattern, lines: job.lines });
  }

  // A new worker's first check: player patterns wait until it is back.
  function rxpProbe() {
    rxpPost({ probe: true, hole: -1, pattern: '^ok$', lines: ['ok'] });
  }

  // Sends the queued check once the worker is free (a new worker's test
  // pattern keeps it busy until the worker is known to work).
  function rxpDispatch() {
    if (rxpRuntime.job || !rxpRuntime.queued) {
      return;
    }
    var next = rxpRuntime.queued;
    rxpRuntime.queued = null;
    rxpPost(next);
  }

  // Worker mode when it can start: a first test pattern has to come back
  // before player patterns go to it.
  function rxpStartSandbox() {
    if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL !== 'function' ||
      typeof URL.createObjectURL !== 'function') {
      rxpUseMain('this browser has no Web Worker');
      return;
    }
    if (rxpSpawn()) {
      rxpRenderSandbox();
      rxpProbe();
    }
  }

  function rxpHandleWorkerMessage(event) {
    var job = rxpRuntime.job;
    var data = event.data;
    if (!job || !data || data.id !== job.id) {
      return;
    }
    clearTimeout(job.timer);
    rxpRuntime.job = null;
    if (job.probe) {
      rxpRuntime.mode = 'worker';
      rxpRenderSandbox();
    } else {
      rxpFinish(job, rxpReadReply(data, job.lines));
    }
    rxpDispatch();
  }

  // An error event: the worker could not load (a Content Security Policy
  // that blocks blob: workers) or died.
  function rxpHandleWorkerError(event) {
    event.preventDefault();
    rxpUseMain('the worker failed: ' + (event.message || 'error event'));
  }

  // A check ran out of time: the worker is stopped and a fresh one takes
  // over once its test pattern is back.  A test pattern that gets no answer
  // means no worker at all.
  function rxpHandleTimeout() {
    var job = rxpRuntime.job;
    rxpRuntime.job = null;
    rxpRuntime.worker.terminate();
    rxpRuntime.worker = null;
    if (job.probe) {
      rxpUseMain('it gave no answer within ' + RXP_PROBE_MS + ' ms');
      return;
    }
    rxpFinish(job, {
      error: 'Stopped after ' + RXP_TIMEOUT_MS + ' ms: /' + job.pattern + '/ backtracks too long on these lines. ' +
        'Nested quantifiers like (a+)+ and repeated alternatives like (a|a)* try every way to split a line.',
      spans: null
    });
    if (rxpSpawn()) {
      rxpProbe();
    }
  }

  // Checks the draft of the hole on screen: at once on the main thread, or
  // queued for the worker (only the newest check waits).
  function rxpEvaluate() {
    var pattern = rxpDraft();
    var job = { probe: false, hole: rxpState.hole, pattern: pattern, lines: rxpHoleLines(rxpCurrentHole()) };
    rxpRuntime.result = null;
    if (!pattern) {
      rxpRenderResult();
      return;
    }
    if (rxpRuntime.mode === 'main') {
      rxpFinish(job, rxpRunMain(pattern, job.lines));
      return;
    }
    var tooLong = rxpTooLong(pattern, false);
    if (tooLong) {
      rxpFinish(job, { error: tooLong, spans: null });
      return;
    }
    rxpRuntime.queued = job;
    rxpRenderResult();
    rxpDispatch();
  }

  // ── Game flow ─────────────────────────────────────────────────────────────

  function rxpQuote(line) {
    return '"' + line + '"';
  }

  // Why a checked pattern is not holed, naming the first line at fault.
  function rxpMissText(pattern, score) {
    var text = 'Not holed: /' + pattern + '/ ';
    if (score.missed.length) {
      text += 'misses ' + rxpQuote(score.missed[0]);
      return text + (score.missed.length > 1 ? ' and ' + (score.missed.length - 1) + ' more to catch.' : '.');
    }
    text += 'also catches ' + rxpQuote(score.extra[0]);
    return text + (score.extra.length > 1 ? ' and ' + (score.extra.length - 1) + ' more to leave.' : '.');
  }

  // Puts a holed pattern on the card (the first of this round) and keeps the
  // hole's best and the best round, merged with what other tabs stored.
  function rxpHoleOut(index, pattern, score) {
    rxpSyncState(rxpState.hole);
    rxpSyncBest();
    var first = rxpState.card[index] === null;
    var entry = rxpState.best.holes[index];
    var better = !entry || score.strokes < entry.strokes;
    var name = 'Hole ' + (index + 1) + ' ';
    var message;
    if (better) {
      rxpState.best.holes[index] = { pattern: pattern, strokes: score.strokes };
    }
    if (first) {
      rxpState.card[index] = score.strokes;
      message = name + 'holed in ' + rxpPlural(score.strokes, 'stroke') + ': ' + rxpScoreName(score.toPar) + ' (' +
        rxpFormatToPar(score.toPar) + ').' + (better ? ' New best for this hole.' : '');
    } else {
      message = name + 'is already on this round\'s card with ' + rxpPlural(rxpState.card[index], 'stroke') + '.' +
        (better ? ' New best: ' + rxpPlural(score.strokes, 'stroke') + '.' : '');
    }
    var total = rxpCourseTotal(rxpState.card);
    var course = rxpState.best.course;
    var record = first && total.complete && (course === null || total.strokes < course);
    if (record) {
      rxpState.best.course = total.strokes;
    }
    if (first && total.complete) {
      message += ' Round ' + rxpState.round + ' complete: ' + total.strokes + ' strokes (' + rxpFormatToPar(total.toPar) +
        ')' + (record ? ', your best round.' : '.');
    }
    rxpSaveState();
    if (better || record) {
      rxpSaveBest();
    }
    rxpRender();
    rxpShowToast(message);
  }

  // A pattern Enter asked for has been checked: hole it out, or say why not.
  function rxpCompleteSubmit(result) {
    if (result.error) {
      rxpShowToast('Not holed: ' + result.error, 'error');
      return;
    }
    var score = rxpScoreHole(RXP_HOLES[result.hole], result.spans, result.pattern);
    if (score.solved) {
      rxpHoleOut(result.hole, result.pattern, score);
    } else {
      rxpShowToast(rxpMissText(result.pattern, score), 'error');
    }
  }

  // Enter or Hole out: scores the draft once its check is in.
  function rxpSubmit() {
    var pattern = rxpDraft();
    if (!pattern) {
      rxpShowToast('Type a pattern first: every character is one stroke.', 'error');
      return;
    }
    var result = rxpShownResult();
    if (result) {
      rxpCompleteSubmit(result);
    } else {
      rxpRuntime.submit = { hole: rxpState.hole, pattern: pattern };
      rxpShowToast('Checking /' + pattern + '/ ... it is scored as soon as the check is in.', 'info');
    }
  }

  // Shows hole index with its draft and checks it.
  function rxpGoTo(index) {
    rxpState.hole = index;
    if (rxpRuntime.submit) {
      // The 'Checking ...' note of an Enter that now scores nothing goes.
      clearTimeout(rxpRuntime.toastTimeout);
      rxpHideToast();
    }
    rxpRuntime.submit = null;
    rxpSyncState(null);
    rxpRuntime.els.pattern.value = rxpDraft();
    rxpBuildLines();
    rxpRender();
    rxpSaveState();
    rxpEvaluate();
  }

  function rxpPrev() {
    if (rxpState.hole > 0) {
      rxpGoTo(rxpState.hole - 1);
    }
  }

  function rxpNext() {
    if (rxpState.hole < RXP_HOLE_COUNT - 1) {
      rxpGoTo(rxpState.hole + 1);
    }
  }

  function rxpDisarm() {
    clearTimeout(rxpRuntime.confirmTimeout);
    rxpRuntime.confirmTimeout = null;
    rxpRuntime.confirming = false;
    rxpRuntime.els.newRound.textContent = 'New round';
    rxpRuntime.els.newRound.setAttribute('aria-label', 'Start a new round with a clean card');
  }

  // New round: a clean card and empty drafts; the bests stay.  With holes
  // on the card or drafts typed, a second press within RXP_CONFIRM_MS is
  // needed.
  function rxpNewRound() {
    rxpTakeOver();
    var total = rxpCourseTotal(rxpState.card);
    var drafts = rxpState.drafts.filter(Boolean).length;
    if ((total.holed || drafts) && !rxpRuntime.confirming) {
      rxpRuntime.confirming = true;
      rxpRuntime.els.newRound.textContent = 'Confirm new round';
      rxpRuntime.els.newRound.setAttribute('aria-label', 'Press again to clear this round\'s card and drafts');
      rxpRuntime.confirmTimeout = setTimeout(rxpDisarm, RXP_CONFIRM_MS);
      rxpShowToast('Press New round again within ' + RXP_CONFIRM_MS / 1000 + ' s to clear round ' + rxpState.round + ': ' +
        rxpPlural(total.holed, 'hole') + ' on the card, ' + rxpPlural(drafts, 'draft') + '. Your bests stay.', 'info');
      return;
    }
    rxpDisarm();
    rxpState.round++;
    rxpState.card = rxpFill(RXP_HOLE_COUNT, null);
    rxpState.drafts = rxpFill(RXP_HOLE_COUNT, '');
    rxpGoTo(0);
    rxpShowToast('Round ' + rxpState.round + ': a clean card. Hole 1, par ' + RXP_HOLES[0].par + '.', 'info');
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  // A keystroke: the draft is saved (merged with another tab's save, whose
  // card may come in with it) and checked.
  function rxpHandleInput() {
    rxpState.drafts[rxpState.hole] = rxpRuntime.els.pattern.value;
    rxpSaveState();
    rxpRenderStrokes();
    rxpRenderCard();
    rxpEvaluate();
  }

  // Enter in the pattern box holes out; every other key is the box's own.
  function rxpHandleKeydown(event) {
    if (event.key !== 'Enter' || event.ctrlKey || event.altKey || event.metaKey || event.isComposing ||
      event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    if (!event.repeat) {
      rxpSubmit();
    }
  }

  // A chip keeps the focus in the pattern box (no keyboard flicker on
  // phones).
  function rxpHandleChipDown(event) {
    if (event.target.closest('.rxp-chip')) {
      event.preventDefault();
    }
  }

  // A chip inserts its token at the caret (over the selection) and puts the
  // caret inside it, never past the box's maxlength of RXP_MAX_PATTERN.  It
  // types the token with the insertText command where the browser has it,
  // so the browser's own undo takes it back; where the command is missing
  // or changed nothing, setRangeText, or a plain write of the value.  The
  // command fires the input event itself; the other two are followed by
  // rxpHandleInput.
  function rxpHandleChipClick(event) {
    var chipEl = event.target.closest('.rxp-chip');
    if (!chipEl) {
      return;
    }
    var chip = RXP_CHIPS[Number(chipEl.getAttribute('data-chip'))];
    var input = rxpRuntime.els.pattern;
    var value = input.value;
    var start = typeof input.selectionStart === 'number' ? input.selectionStart : value.length;
    var end = typeof input.selectionEnd === 'number' ? input.selectionEnd : start;
    var length = value.length - (end - start) + chip[0].length;
    if (length > RXP_MAX_PATTERN) {
      rxpShowToast('Not inserted: ' + chip[0] + ' would make the pattern ' + length + ' characters long, and the box ' +
        'takes up to ' + RXP_MAX_PATTERN + '.', 'error');
      return;
    }
    input.focus();
    var typed = document.activeElement === input && typeof document.execCommand === 'function' &&
      document.execCommand('insertText', false, chip[0]) && input.value !== value;
    if (!typed) {
      if (typeof input.setRangeText === 'function') {
        input.setRangeText(chip[0], start, end, 'end');
      } else {
        input.value = value.slice(0, start) + chip[0] + value.slice(end);
      }
    }
    if (typeof input.setSelectionRange === 'function') {
      input.setSelectionRange(start + chip[1], start + chip[1]);
    }
    if (input.value !== rxpDraft()) {
      rxpHandleInput();
    }
  }

  function rxpHandleCardClick(event) {
    var cell = event.target.closest('.rxp-card-cell');
    if (cell) {
      var index = Number(cell.getAttribute('data-hole'));
      if (index !== rxpState.hole) {
        rxpGoTo(index);
      }
    }
  }

  // What another tab saved, taken over: a draft on screen that changed is
  // put in the box and checked again.
  function rxpTakeOver() {
    var draft = rxpDraft();
    var changed = rxpSyncState(null);
    var best = rxpSyncBest();
    if (!changed && !best) {
      return;
    }
    if (rxpDraft() !== draft) {
      rxpRuntime.els.pattern.value = rxpDraft();
      rxpRender();
      rxpEvaluate();
    } else {
      rxpRender();
    }
  }

  function rxpHandleStorage(event) {
    if (event.key === RXP_STATE_KEY || event.key === RXP_BEST_KEY) {
      rxpTakeOver();
    }
  }

  // A tab shown again reads the saves back (the storage event does not
  // reach a page in the back/forward cache).
  function rxpHandleVisibility() {
    if (!document.hidden) {
      rxpTakeOver();
    }
  }

  function rxpBindEvents() {
    var els = rxpRuntime.els;
    els.pattern.addEventListener('input', rxpHandleInput);
    els.pattern.addEventListener('keydown', rxpHandleKeydown);
    els.chips.addEventListener('mousedown', rxpHandleChipDown);
    els.chips.addEventListener('click', rxpHandleChipClick);
    els.card.addEventListener('click', rxpHandleCardClick);
    els.prev.addEventListener('click', rxpPrev);
    els.next.addEventListener('click', rxpNext);
    els.submit.addEventListener('click', rxpSubmit);
    els.newRound.addEventListener('click', rxpNewRound);
    document.addEventListener('visibilitychange', rxpHandleVisibility);
    window.addEventListener('storage', rxpHandleStorage);
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  function rxpFindElements() {
    return {
      holeNumber: document.getElementById('rxp-hole-number'),
      holeTitle: document.getElementById('rxp-hole-title'),
      holeSource: document.getElementById('rxp-hole-source'),
      holeTask: document.getElementById('rxp-hole-task'),
      par: document.getElementById('rxp-par'),
      strokes: document.getElementById('rxp-strokes'),
      score: document.getElementById('rxp-score'),
      bestHole: document.getElementById('rxp-best-hole'),
      pattern: document.getElementById('rxp-pattern'),
      chips: document.getElementById('rxp-chips'),
      live: document.getElementById('rxp-live'),
      matchList: document.getElementById('rxp-match-list'),
      skipList: document.getElementById('rxp-skip-list'),
      matchCount: document.getElementById('rxp-match-count'),
      skipCount: document.getElementById('rxp-skip-count'),
      status: document.getElementById('rxp-status'),
      sandbox: document.getElementById('rxp-sandbox'),
      prev: document.getElementById('rxp-prev'),
      next: document.getElementById('rxp-next'),
      submit: document.getElementById('rxp-submit'),
      newRound: document.getElementById('rxp-new-round'),
      card: document.getElementById('rxp-card'),
      course: document.getElementById('rxp-course'),
      bestCourse: document.getElementById('rxp-best-course'),
      warning: document.getElementById('rxp-warning'),
      toast: document.getElementById('rxp-toast')
    };
  }

  // Finds the elements, builds the chips and the card, binds everything
  // once, restores the saves (writing nothing) and starts the sandbox.
  function rxpInit() {
    if (rxpRuntime.els) {
      return;
    }
    rxpRuntime.els = rxpFindElements();
    rxpBuildChips();
    rxpBuildCard();
    rxpBindEvents();
    rxpRuntime.bestText = rxpStorageGet(RXP_BEST_KEY);
    rxpState.best = rxpParseBest(rxpRuntime.bestText);
    rxpRuntime.stateText = rxpStorageGet(RXP_STATE_KEY);
    var saved = rxpParseState(rxpRuntime.stateText);
    rxpState.hole = saved.hole;
    rxpApplyState(saved);
    rxpRuntime.els.pattern.value = rxpDraft();
    rxpBuildLines();
    rxpStartSandbox();
    rxpRender();
    rxpEvaluate();
  }

  // Node (tests): export only, no init, no worker and no timers.  Browser:
  // init once the markup is there.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      rxpState: rxpState,
      rxpRuntime: rxpRuntime,
      rxpInit: rxpInit,
      rxpHoles: RXP_HOLES,
      rxpChips: RXP_CHIPS,
      rxpWorkerSource: RXP_WORKER_SOURCE,
      rxpCoursePar: rxpCoursePar,
      rxpFormatToPar: rxpFormatToPar,
      rxpScoreName: rxpScoreName,
      rxpQuantifierAt: rxpQuantifierAt,
      rxpBacktrack: rxpBacktrack,
      rxpIsRisky: rxpIsRisky,
      rxpCompileSafe: rxpCompileSafe,
      rxpRunMain: rxpRunMain,
      rxpReadReply: rxpReadReply,
      rxpScoreHole: rxpScoreHole,
      rxpCourseTotal: rxpCourseTotal,
      rxpParseState: rxpParseState,
      rxpParseBest: rxpParseBest,
      rxpMergeState: rxpMergeState,
      rxpMergeBest: rxpMergeBest
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', rxpInit);
  } else {
    rxpInit();
  }
})();
