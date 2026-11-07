// Lost in /var — script.js
// Prefix: liv-
// Dependencies: none.
//
// A fake shell on a server that broke.  Each case is a short detective
// story: read the logs, list the processes, and stop the cause with real
// commands (ls, cd, pwd, cat, grep, tail, ps, df, kill, plus help and
// clear).  Case 1 is a tutorial whose steps teach every command; cases 2
// and 3 are incidents: a disk filled by a looping export, and a port still
// held by the old release.  An incident closes only when the evidence was
// on screen (the log lines that name the cause) and the cause is stopped,
// so a guess from ps aux alone never closes it.  Nothing is ever deleted:
// there is no rm.
//
// Cases are plain data (LIV_CASES): a file tree as a flat map of paths, the
// processes, the file systems for df, the goals, the hints and the texts.
// A new case is one more object in that list, without code changes.  The
// shell is pure: livParse(line) splits a line into a pipeline, each command
// is a function of (case, world, arguments, piped input), livRun runs a
// line and livCheckWin tells whether every goal of the case is met.  The
// world is what changed against the case's data: the current folder, the
// killed processes and the goals met.
//
// Score per case: 100 points, minus 3 for every command beyond the case's
// par, 10 for every hint and 25 for every wrong process killed, at least
// 10.  help, clear and empty lines are not counted.  The best score of each
// case is kept.  A hint once seen stays seen: Restart starts the server
// over but keeps the hints of the case (and their cost).
//
// Keys: only in the command field.  Enter runs, Up / Down browse the
// history, Tab completes a path or a command name when the field is not
// empty (on an empty field, and with Shift, Tab moves the focus on as
// usual).  Ctrl / Alt / Cmd combinations and every key typed elsewhere on
// the host page are left alone.  Phones: chips type commands and the names
// shown by the last output, and the arrow, Tab and Run buttons do the rest,
// so a case can be solved without the keyboard.  A chip clicked with a
// mouse or the keyboard hands the focus back to the command field (so
// Enter runs the line); a tap leaves it, so no on-screen keyboard opens.
//
// Saves: liv-state (the case on screen and, per case, the current folder,
// the killed processes, the goals met, the command history, the command
// count and the hints used) and liv-progress (the best score of each solved
// case).  Every field is checked on load and falls back on its own;
// storage that is blocked or full never stops the game, and a warning names
// each key that is not saved.  Tabs: another tab's liv-state is taken over
// through the storage event and before every command, and liv-progress is
// merged with what is stored before it is written, so no tab erases
// another's score.
//
// Start-up: under Node (module.exports exists) loading only exports the
// functions for the tests; in a browser livInit runs on DOMContentLoaded,
// or at once when the page has already loaded.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var LIV_STATE_KEY = 'liv-state';
  var LIV_PROGRESS_KEY = 'liv-progress';
  var LIV_SAVE_VERSION = 1;
  // Each saved key and what it holds, for the storage warning.
  var LIV_SAVED = [
    { key: LIV_STATE_KEY, what: 'your sessions' },
    { key: LIV_PROGRESS_KEY, what: 'your points' }
  ];

  var LIV_TOAST_MS = 2000;
  var LIV_CONFIRM_MS = 4000;
  var LIV_HISTORY_MAX = 100;
  var LIV_LINE_MAX = 300;
  var LIV_SCREEN_MAX = 400;
  var LIV_NAMES_MAX = 12;
  var LIV_COUNT_MAX = 99999;

  var LIV_POINTS_START = 100;
  var LIV_POINTS_EXTRA = 3;
  var LIV_POINTS_HINT = 10;
  var LIV_POINTS_MISTAKE = 25;
  var LIV_POINTS_FLOOR = 10;

  var LIV_UNITS = ['K', 'M', 'G', 'T'];
  var LIV_COMMAND_NAMES = ['cat', 'cd', 'clear', 'df', 'grep', 'help', 'kill', 'ls', 'ps', 'pwd', 'tail'];
  var LIV_UNCOUNTED = ['clear', 'help'];
  var LIV_PIPE_READERS = ['grep', 'tail'];
  var LIV_DELETERS = ['rm', 'rmdir', 'shred', 'truncate', 'unlink'];
  var LIV_UNSUPPORTED = [';', '&', '>', '<', '`'];
  // The signals kill knows, by number and name (SIG in front and the case
  // of the letters are optional).
  var LIV_SIGNALS = [
    { num: '1', name: 'HUP' },
    { num: '2', name: 'INT' },
    { num: '9', name: 'KILL' },
    { num: '15', name: 'TERM' }
  ];
  var LIV_REASONS = {
    missing: 'No such file or directory',
    denied: 'Permission denied',
    notdir: 'Not a directory',
    isdir: 'Is a directory'
  };
  var LIV_LONG_ALIGN = ['l', 'r', 'l', 'l', 'r', 'l', 'l'];
  var LIV_KILL_USAGE = 'kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]';

  // A ps aux row, an absolute path after a space, quote, bracket, = or
  // comma (never a trailing dot), and "pid 1234": the names a chip offers.
  var LIV_PS_ROW = /^\S+\s+(\d+)\s+\d+\.\d\s+\d+\.\d\s/;
  var LIV_PATH_RE = /(^|[\s\x22\x27(=,])(\/[A-Za-z0-9._\/-]*[A-Za-z0-9_\/-])/g;
  var LIV_PID_RE = /\bpid (\d+)/g;

  // The chips under the terminal: fill replaces the command line, add
  // appends to it.
  var LIV_CHIPS = [
    { label: 'ls', fill: 'ls' },
    { label: 'ls -lah', fill: 'ls -lah' },
    { label: 'cd', fill: 'cd ' },
    { label: 'cd ..', fill: 'cd ..' },
    { label: 'pwd', fill: 'pwd' },
    { label: 'cat', fill: 'cat ' },
    { label: 'tail', fill: 'tail ' },
    { label: 'grep -i', fill: 'grep -i ' },
    { label: '| grep', add: '| grep ' },
    { label: 'ps aux', fill: 'ps aux' },
    { label: 'df -h', fill: 'df -h' },
    { label: 'kill', fill: 'kill ' },
    { label: 'help', fill: 'help' }
  ];

  var LIV_HELP_ALL = [
    'Commands on this server (help <command> shows its flags):',
    '  ls [-l -a -h] [path...]   list a folder; folders end in /',
    '  cd [path]                 change folder: .. is up, ~ is home',
    '  pwd                       show the current folder',
    '  cat file...               print files',
    '  grep [-i -n -v -r] text [file...]   lines that contain text',
    '  tail [-n N] [file...]     the last lines (10 by default)',
    '  ps [aux]                  your processes, or all of them with aux',
    '  df [-h] [path...]         disk space per file system',
    '  kill [-9] pid...          stop a process by its id (kill -l lists the signals)',
    '  clear                     clear the screen',
    'Pipes: ps aux | grep node, or cat app.log | tail -n 5.',
    'Tab completes names, * matches several (cat /var/log/*.log), Up and Down bring back commands.',
    'There is no rm: on this shift you find the cause and stop it.'
  ];

  var LIV_HELP = {
    ls: ['ls [-l] [-a] [-h] [path...]: list folders, or name files',
      '  -l  long listing: permissions, owner, size and date',
      '  -a  also the names that start with a dot',
      '  -h  sizes such as 4.0K or 17G (with -l)'],
    cd: ['cd [path]: change the current folder',
      '  cd alone or cd ~ goes home, cd .. one folder up, cd / to the top'],
    pwd: ['pwd: show the current folder'],
    cat: ['cat file...: print the files one after another'],
    grep: ['grep [-i] [-n] [-v] [-r] text [file...]: print the lines that contain text',
      '  text is plain text, not a pattern; quote it when it has spaces: grep "No space" error.log',
      '  -i  ignore upper and lower case',
      '  -n  number the lines',
      '  -v  the lines that do not contain text',
      '  -r  search every file in the folders named (the current folder by default)',
      '  without a file it reads a pipe: ps aux | grep node'],
    tail: ['tail [-n N] [file...]: print the last N lines (10 by default)',
      '  -n N  how many lines (tail -5 works too)',
      '  without a file it reads a pipe: cat app.log | tail -n 3'],
    ps: ['ps [aux]: list processes',
      '  ps      the processes of this terminal',
      '  ps aux  every process, with its user, id, CPU and memory (ps ax and ps -ef work too)'],
    df: ['df [-h] [path...]: free and used space per file system',
      '  -h  sizes such as 2.0G instead of 1K blocks',
      '  with a path, only the file system that holds it'],
    kill: ['kill [-signal] pid...: stop processes by their id (see ps aux)',
      '  -9 or -KILL cannot be ignored, -15 or -TERM (the default) asks nicely',
      '  -s TERM or -n 15 name the signal the long way',
      '  -l lists the signals; kill -l 9 names one',
      '  you can only stop your own processes'],
    help: ['help [command]: the commands, or the flags of one'],
    clear: ['clear: clear the screen (the history stays)']
  };

  // ── Cases ─────────────────────────────────────────────────────────────────
  //
  // A case: id, title, host, user, home, shellPid (the user's -bash), psPid
  // (the id ps shows for itself), time (the default date of ls -l), motd and
  // brief (texts), goals ({ text, example?, test }), hints ({ text, example
  // }), par (the commands a good run needs), win (texts), dirs (path ->
  // { owner?, mode? }: folders that hold nothing, or have other owners or
  // modes), files (path -> { lines, owner?, mode?, time?, size?, afterKill?:
  // { pid, lines } added once pid is killed }), procs ({ pid, user, cpu, mem,
  // cmd, onKill?: texts shown when killed, keep?: true when killing it is a
  // mistake, frees?: { mount, bytes }, removes?: paths gone with it }) and
  // mounts ({ fs, size, used, mount } in bytes).
  //
  // A goal's test is one of { killed: pid } (that process is stopped),
  // { cwd: path } (the shell went there) or { run?: command, read?: path,
  // saw?: text }: a line ran that command (any command when run is left
  // out), which read the file (for grep: found a line in it), and whose
  // output on screen has a line holding text.  With neither read nor saw
  // the command must succeed (exit status 0).  saw checks what the player
  // was shown, so a pipe counts (cat x.log | tail -n 3) and an empty
  // output does not (tail -n 0 x.log).  An incident's evidence is a saw
  // goal on log lines that stay after the kill, so the order is free.

  var LIV_CASES = [
    {
      id: 'tutorial',
      title: 'First shift',
      host: 'training-01',
      user: 'ops',
      home: '/home/ops',
      shellPid: 1001,
      psPid: 1188,
      time: 'Nov  6 08:00',
      motd: [
        'Linux training-01 6.1.0-27-amd64 x86_64',
        'Last login: Fri Nov  6 07:58:12 2026 from 10.0.0.12',
        '',
        'Training ticket: something on this box beeps all day long.',
        'Follow the steps in the case panel. Type help for the commands.'
      ],
      brief: 'Your first shift. Something on training-01 beeps every second. Each step teaches one command; its button types the command for you.',
      goals: [
        { text: 'See what is in your home folder.', example: 'ls', test: { run: 'ls' } },
        { text: 'Read the note the team left you.', example: 'cat welcome.txt', test: { run: 'cat', read: '/home/ops/welcome.txt' } },
        { text: 'Go to the folder where the logs live.', example: 'cd /var/log', test: { cwd: '/var/log' } },
        { text: 'Show the last 3 lines of beeper.log.', example: 'tail -n 3 beeper.log', test: { run: 'tail', saw: 'still beeping: stop me' } },
        { text: 'Find the line of beeper.log that names its process id.', example: 'grep pid beeper.log', test: { run: 'grep', saw: 'starting (pid 3141)' } },
        { text: 'Check how full the disks are.', example: 'df -h', test: { run: 'df' } },
        { text: 'List every running process.', example: 'ps aux', test: { run: 'ps', saw: '/sbin/init' } },
        { text: 'Stop the beeper by its process id.', example: 'kill 3141', test: { killed: 3141 } }
      ],
      hints: [],
      par: 8,
      win: [
        'Case closed: training-01 is quiet again.',
        'You used ls, cat, cd, tail, grep, df, ps and kill: the whole toolbox for the next two cases.'
      ],
      dirs: {
        '/home/ops': { owner: 'ops' },
        '/root': { mode: 'drwx------' },
        '/run': {},
        '/tmp': { mode: 'drwxrwxrwt' }
      },
      files: {
        '/etc/hostname': { lines: ['training-01'] },
        '/etc/motd': { lines: ['Training box: nothing here is real, so look around.'] },
        '/home/ops/.profile': { owner: 'ops', lines: ['# ~/.profile', 'export EDITOR=nano'] },
        '/home/ops/todo.txt': { owner: 'ops', lines: ['1. read welcome.txt', '2. stop the beeper', '3. coffee'] },
        '/home/ops/welcome.txt': {
          owner: 'ops',
          lines: [
            'Welcome to the team!',
            '',
            'Something on training-01 beeps every second and drives everyone mad.',
            'It writes a log to /var/log/beeper.log. Go there with: cd /var/log',
            'Look at the end of the log with tail, find its process id with grep,',
            'and stop it with kill. df shows the disks, ps aux the processes.',
            '',
            'House rule: we never delete files to fix things. Find the cause.',
            '- the on-call team'
          ]
        },
        '/var/log/auth.log': { mode: '-rw-r-----', lines: ['Nov  6 07:58:12 training-01 sshd[530]: Accepted publickey for ops'] },
        '/var/log/beeper.log': {
          owner: 'ops',
          lines: [
            '08:00:00 beeper 1.0 starting (pid 3141)',
            '08:00:01 BEEP',
            '08:00:02 BEEP',
            '08:00:03 BEEP',
            '08:00:04 warning: volume at 11',
            '08:00:05 BEEP',
            '08:00:06 BEEP',
            '08:00:07 BEEP',
            '08:00:08 BEEP',
            '08:00:09 BEEP',
            '08:00:10 BEEP',
            '08:00:11 still beeping: stop me with kill and my process id'
          ],
          afterKill: { pid: 3141, lines: ['08:00:12 beeper 1.0 got SIGTERM: bye'] }
        },
        '/var/log/syslog': {
          lines: [
            'Nov  6 07:58:12 training-01 sshd[530]: session opened for user ops',
            'Nov  6 08:00:00 training-01 beeper[3141]: started by ops'
          ]
        }
      },
      procs: [
        { pid: 1, user: 'root', cpu: 0, mem: 0.1, cmd: '/sbin/init' },
        { pid: 412, user: 'root', cpu: 0, mem: 0, cmd: '/usr/sbin/cron -f' },
        { pid: 530, user: 'root', cpu: 0, mem: 0.1, cmd: '/usr/sbin/sshd -D' },
        { pid: 1001, user: 'ops', cpu: 0, mem: 0.1, cmd: '-bash' },
        {
          pid: 3141, user: 'ops', cpu: 2, mem: 0.1, cmd: '/usr/local/bin/beeper --every 1s --volume 11',
          onKill: ['[monitor] beeper (pid 3141) stopped. Silence on training-01.']
        }
      ],
      mounts: [
        { fs: '/dev/sda1', size: 21474836480, used: 6656360448, mount: '/' },
        { fs: 'tmpfs', size: 1073741824, used: 1310720, mount: '/run' }
      ]
    },
    {
      id: 'disk-full',
      title: 'No space left',
      host: 'web-01',
      user: 'ops',
      home: '/home/ops',
      shellPid: 1544,
      psPid: 2398,
      time: 'Nov  6 03:10',
      motd: [
        'Linux web-01 6.1.0-27-amd64 x86_64',
        'Last login: Fri Nov  6 08:41:07 2026 from 10.0.0.12',
        '',
        'Ticket #4821 (urgent): checkout on the shop fails with error 500 since 03:10.',
        'Find the cause and stop it. Deleting files is not your call on prod.'
      ],
      brief: 'Ticket #4821: checkout on the shop fails with error 500 since 03:10. Find out why and stop the cause, without deleting anything.',
      goals: [
        { text: 'Find the error behind the failed checkouts.', test: { saw: 'No space left on device' } },
        { text: 'Find what fills the disk, and why it never stops.', test: { saw: '--loop runs batch 1 again' } },
        { text: 'Stop the cause, without deleting anything.', test: { killed: 2231 } }
      ],
      hints: [
        { text: 'Start where the web server writes its errors.', example: 'tail /var/log/nginx/error.log' },
        { text: 'Error 28 means a full disk. Look for a big file in /var/tmp: its name tells which program writes it.', example: 'ls -lh /var/tmp' },
        { text: 'The export logs to /var/log/shop/. Read why it never stops; the log names its process id too.', example: 'tail /var/log/shop/export.log' }
      ],
      par: 6,
      win: [
        'Case closed: checkout answers 200 OK again.',
        'The export looped on batch 1 (--loop) and filled / with its spool. Follow-up for the day team: drop --loop from /etc/cron.d/shop-export.'
      ],
      dirs: {
        '/home/ops': { owner: 'ops' },
        '/root': { mode: 'drwx------' },
        '/run': {},
        '/boot/efi': {},
        '/tmp': { mode: 'drwxrwxrwt' },
        '/var/lib/nginx/body': { owner: 'www-data', mode: 'drwx------' },
        '/var/tmp': { mode: 'drwxrwxrwt' }
      },
      files: {
        '/etc/cron.d/shop-export': {
          lines: [
            '# m h dom mon dow user command',
            '0 3 * * * ops /opt/shop/bin/export --debug --loop',
            '# TODO(dana): drop --debug --loop after the test run'
          ]
        },
        '/etc/hostname': { lines: ['web-01'] },
        '/etc/nginx/sites-enabled/shop': {
          lines: [
            'server {',
            '    server_name shop.example.test;',
            '    client_body_temp_path /var/lib/nginx/body;',
            '    location / { fastcgi_pass unix:/run/php/php-fpm.sock; }',
            '}'
          ]
        },
        '/home/ops/notes.txt': {
          owner: 'ops',
          lines: [
            'web-01: nginx in front of php-fpm (the shop).',
            'The nightly warehouse export runs from cron at 03:00 and logs to /var/log/shop/.',
            'Policy: no rm on prod. Stop the cause, then file a cleanup ticket.'
          ]
        },
        '/opt/shop/bin/export': {
          mode: '-rwxr-xr-x',
          lines: [
            '#!/bin/sh',
            '# warehouse export 2.3: spools the orders to /var/tmp, then uploads them',
            'exec php /opt/shop/lib/export.php "$@"'
          ]
        },
        '/var/log/auth.log': { mode: '-rw-r-----', lines: ['Nov  6 08:41:07 web-01 sshd[512]: Accepted publickey for ops'] },
        '/var/log/nginx/access.log': {
          owner: 'www-data',
          lines: [
            '203.0.113.7 - - [06/Nov/2026:03:10:44 +0000] "POST /checkout HTTP/1.1" 500 182',
            '198.51.100.24 - - [06/Nov/2026:05:22:09 +0000] "POST /checkout HTTP/1.1" 500 182',
            '203.0.113.61 - - [06/Nov/2026:08:40:31 +0000] "POST /checkout HTTP/1.1" 500 182',
            '203.0.113.61 - - [06/Nov/2026:08:40:35 +0000] "GET / HTTP/1.1" 200 5120'
          ]
        },
        '/var/log/nginx/error.log': {
          owner: 'www-data',
          lines: [
            '2026/11/06 02:58:12 [notice] 1020#1020: signal process started',
            '2026/11/06 03:10:44 [crit] 1022#1022: *8812 open() "/var/lib/nginx/body/0000000412" failed (28: No space left on device), client: 203.0.113.7, server: shop.example.test, request: "POST /checkout HTTP/1.1"',
            '2026/11/06 03:10:44 [error] 1022#1022: *8812 FastCGI sent in stderr: "PHP Warning: session_start(): write failed: No space left on device (28)"',
            '2026/11/06 05:22:09 [crit] 1022#1022: *9150 open() "/var/lib/nginx/body/0000000977" failed (28: No space left on device), client: 198.51.100.24, server: shop.example.test, request: "POST /checkout HTTP/1.1"',
            '2026/11/06 08:40:31 [crit] 1022#1022: *11873 open() "/var/lib/nginx/body/0000001506" failed (28: No space left on device), client: 203.0.113.61, server: shop.example.test, request: "POST /checkout HTTP/1.1"'
          ]
        },
        '/var/log/shop/export.log': {
          owner: 'ops',
          lines: [
            '03:00:01 export 2.3 started by cron (pid 2231), flags: --debug --loop',
            '03:00:01 spooling to /var/tmp/export-2231.spool',
            '03:00:04 batch 1: 5000 orders spooled',
            '03:00:07 batch 1: 5000 orders spooled',
            '03:00:07 debug: the cursor did not move, --loop runs batch 1 again',
            '03:00:10 batch 1: 5000 orders spooled',
            '03:10:41 write warning: spool at 17G, disk at 100%',
            '08:41:02 batch 1: 5000 orders spooled'
          ],
          afterKill: { pid: 2231, lines: ['08:42:00 got SIGTERM: spool removed, export stopped'] }
        },
        '/var/log/shop/orders.log': {
          owner: 'ops',
          lines: [
            '03:09:58 order 100412 paid EUR 41.90',
            '03:10:44 order 100413 failed: checkout error 500',
            '05:22:09 order 100414 failed: checkout error 500',
            '08:40:31 order 100415 failed: checkout error 500'
          ]
        },
        '/var/tmp/apt-cache.bin': { size: 2202009, lines: ['(binary package cache)'] },
        '/var/tmp/export-2231.spool': {
          owner: 'ops',
          size: 18253611008,
          time: 'Nov  6 08:41',
          lines: [
            'order 100001,2026-11-05,EUR 41.90',
            'order 100002,2026-11-05,EUR 12.00',
            'order 100003,2026-11-05,EUR 99.50',
            'order 100001,2026-11-05,EUR 41.90'
          ]
        }
      },
      procs: [
        { pid: 1, user: 'root', cpu: 0, mem: 0.1, cmd: '/sbin/init' },
        { pid: 488, user: 'root', cpu: 0, mem: 0, cmd: '/usr/sbin/cron -f' },
        { pid: 512, user: 'root', cpu: 0, mem: 0.1, cmd: '/usr/sbin/sshd -D' },
        { pid: 1020, user: 'root', cpu: 0, mem: 0.2, cmd: 'nginx: master process /usr/sbin/nginx' },
        { pid: 1022, user: 'www-data', cpu: 0.3, mem: 0.4, cmd: 'nginx: worker process' },
        { pid: 1190, user: 'www-data', cpu: 1.2, mem: 2.8, cmd: 'php-fpm: pool shop' },
        { pid: 1544, user: 'ops', cpu: 0, mem: 0.1, cmd: '-bash' },
        {
          pid: 2231, user: 'ops', cpu: 38.5, mem: 1.9, cmd: '/opt/shop/bin/export --debug --loop',
          frees: { mount: '/', bytes: 18253611008 },
          removes: ['/var/tmp/export-2231.spool'],
          onKill: [
            '[monitor] export (pid 2231) exited. Its spool /var/tmp/export-2231.spool was removed: 17G free on / again.',
            '[monitor] POST /checkout: 200 OK'
          ]
        },
        {
          pid: 2290, user: 'ops', cpu: 0, mem: 0, cmd: 'tail -f /var/log/shop/orders.log',
          keep: true,
          onKill: ['[monitor] dana: hey, who closed my tail -f on orders.log? I was watching the failed orders. That was not the cause.']
        }
      ],
      mounts: [
        { fs: '/dev/sda1', size: 42949672960, used: 42949672960, mount: '/' },
        { fs: '/dev/sda15', size: 129718272, used: 6402048, mount: '/boot/efi' },
        { fs: 'tmpfs', size: 2147483648, used: 1310720, mount: '/run' }
      ]
    },
    {
      id: 'port-clash',
      title: 'Address in use',
      host: 'app-03',
      user: 'deploy',
      home: '/home/deploy',
      shellPid: 2010,
      psPid: 4790,
      time: 'Nov  6 09:12',
      motd: [
        'Linux app-03 6.1.0-27-amd64 x86_64',
        'Last login: Fri Nov  6 09:38:55 2026 from 10.0.0.12',
        '',
        'Ticket #4830: release 42 was deployed at 09:12, but the site still serves release 41',
        'and the health check of release 42 fails. Get release 42 serving.'
      ],
      brief: 'Ticket #4830: release 42 was deployed at 09:12, yet the site still serves release 41 and the health check of release 42 fails. Get release 42 serving.',
      goals: [
        { text: 'Find why release 42 cannot start.', test: { saw: 'EADDRINUSE' } },
        { text: 'Find which process still holds the port.', test: { saw: '(pid 3107)' } },
        { text: 'Stop that process, keep the mail queue running, and get release 42 serving.', test: { killed: 3107 } }
      ],
      hints: [
        { text: 'Each release logs to /var/log/app/. Read what release 42 says.', example: 'tail /var/log/app/release-42.log' },
        { text: 'EADDRINUSE: another process already listens on that port. Which release started on 0.0.0.0:8080?', example: 'grep 8080 /var/log/app/release-41.log' },
        { text: 'Find the release 41 server in the process list and stop it; its queue worker still has mail to send.', example: 'ps aux | grep 41' }
      ],
      par: 6,
      win: [
        'Case closed: release 42 serves on :8080 and its health check is green.',
        'The deploy gave up stopping release 41 after 10 s, so the old server kept the port. Follow-up: make the deploy fail when the old server does not stop.'
      ],
      dirs: {
        '/home/deploy': { owner: 'deploy' },
        '/root': { mode: 'drwx------' },
        '/run': {},
        '/tmp': { mode: 'drwxrwxrwt' }
      },
      files: {
        '/etc/app/app.env': { owner: 'deploy', lines: ['PORT=8080', 'NODE_ENV=production', 'QUEUE=redis://127.0.0.1:6379/0'] },
        '/etc/hostname': { lines: ['app-03'] },
        '/home/deploy/notes.txt': {
          owner: 'deploy',
          lines: [
            'Deploys on app-03:',
            '1. ci copies the release to /srv/app/releases/<n>',
            '2. the deploy script stops the old server (see /var/log/app/deploy.log)',
            '3. launcher.js starts the new one on PORT from /etc/app/app.env',
            'The queue worker of the old release runs on until its mail queue is empty.'
          ]
        },
        '/srv/app/releases/41/VERSION': { owner: 'deploy', lines: ['41'] },
        '/srv/app/releases/41/queue.js': { owner: 'deploy', lines: ['// release 41: sends the mail queue, needs no port'] },
        '/srv/app/releases/41/server.js': { owner: 'deploy', lines: ['// release 41', 'app.listen(process.env.PORT);'] },
        '/srv/app/releases/42/VERSION': { owner: 'deploy', lines: ['42'] },
        '/srv/app/releases/42/launcher.js': { owner: 'deploy', lines: ['// starts server.js and retries every 5 s while the port is busy'] },
        '/srv/app/releases/42/server.js': { owner: 'deploy', lines: ['// release 42', 'app.listen(process.env.PORT);'] },
        '/var/log/app/deploy.log': {
          owner: 'deploy',
          lines: [
            '09:11:58 deploy of release 42 started by ci',
            '09:12:01 copied to /srv/app/releases/42',
            '09:12:02 stopping the release 41 server (pid 3107) with SIGTERM',
            '09:12:12 the release 41 server did not exit within 10 s: skipped',
            '09:12:12 starting release 42 with launcher.js',
            '09:12:13 deploy finished with 1 warning'
          ]
        },
        '/var/log/app/release-41.log': {
          owner: 'deploy',
          lines: [
            'Nov  5 16:20:41 server.js 41 listening on 0.0.0.0:8080 (pid 3107)',
            'Nov  5 16:20:42 queue.js 41 started (pid 3110)',
            'Nov  6 09:12:02 server.js 41 got SIGTERM: waiting for 1 open request to finish',
            'Nov  6 09:38:40 server.js 41 still waiting: GET /export/all open for 26 min'
          ],
          afterKill: { pid: 3107, lines: ['Nov  6 09:40:01 server.js 41 exited'] }
        },
        '/var/log/app/release-42.log': {
          owner: 'deploy',
          lines: [
            '09:12:13 launcher: starting /srv/app/releases/42/server.js on 0.0.0.0:8080',
            '09:12:13 Error: listen EADDRINUSE: address already in use 0.0.0.0:8080',
            '09:12:13 launcher: retry 1 in 5 s',
            '09:12:18 Error: listen EADDRINUSE: address already in use 0.0.0.0:8080',
            '09:12:18 launcher: retry 2 in 5 s',
            '09:38:53 Error: listen EADDRINUSE: address already in use 0.0.0.0:8080',
            '09:38:53 launcher: retry 321 in 5 s'
          ],
          afterKill: { pid: 3107, lines: ['09:40:03 server.js 42 listening on 0.0.0.0:8080', '09:40:04 health check /healthz: 200 OK'] }
        },
        '/var/log/auth.log': { mode: '-rw-r-----', lines: ['Nov  6 09:38:55 app-03 sshd[640]: Accepted publickey for deploy'] }
      },
      procs: [
        { pid: 1, user: 'root', cpu: 0, mem: 0.1, cmd: '/sbin/init' },
        { pid: 640, user: 'root', cpu: 0, mem: 0.1, cmd: '/usr/sbin/sshd -D' },
        { pid: 702, user: 'redis', cpu: 0.4, mem: 1.1, cmd: '/usr/bin/redis-server 127.0.0.1:6379' },
        { pid: 2010, user: 'deploy', cpu: 0, mem: 0.1, cmd: '-bash' },
        {
          pid: 3107, user: 'deploy', cpu: 0.8, mem: 4.2, cmd: 'node /srv/app/releases/41/server.js',
          onKill: [
            '[monitor] release 41 server (pid 3107) exited.',
            '[monitor] launcher.js: release 42 bound 0.0.0.0:8080, health check 200 OK.'
          ]
        },
        {
          pid: 3110, user: 'deploy', cpu: 0.2, mem: 1.6, cmd: 'node /srv/app/releases/41/queue.js',
          keep: true,
          onKill: ['[monitor] queue.js 41 (pid 3110) stopped with 37 mail jobs still queued: receipts go out late. That was the wrong process.']
        },
        { pid: 4410, user: 'root', cpu: 0.1, mem: 0.6, cmd: 'node /srv/app/releases/42/launcher.js --retry 5s' }
      ],
      mounts: [
        { fs: '/dev/vda1', size: 26843545600, used: 9770000000, mount: '/' },
        { fs: 'tmpfs', size: 1073741824, used: 1048576, mount: '/run' }
      ]
    }
  ];

  // ── State ─────────────────────────────────────────────────────────────────

  // caseId: the case on screen.  sessions: case id -> { cwd, killed, done,
  // history, commands, hints } (livParseSession).  progress: case id ->
  // { score, commands, hints }, the best solve of each case.
  var livState = {
    caseId: LIV_CASES[0].id,
    sessions: {},
    progress: {}
  };

  // The page: elements, the liv-state text last read or written (stateText),
  // the storage keys that failed (failed: key -> 'blocked' | 'full'), the
  // terminal lines per case (screens), the name chips of the last output,
  // the history browsing position and the line typed before it (draft),
  // the pointer that pressed a chip last, the timers, and the keys of the
  // lists drawn last (so a click on a chip
  // never rebuilds the chip under the pointer).
  var livRuntime = {
    els: null,
    stateText: null,
    failed: {},
    screens: {},
    names: [],
    historyPos: 0,
    draft: '',
    pointer: '',
    toastTimeout: null,
    confirmTimeout: null,
    confirming: false,
    caseButtons: [],
    goalsKey: null,
    hintsKey: null,
    namesKey: null
  };

  // ── Helpers (no DOM) ──────────────────────────────────────────────────────

  function livHasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function livRepeat(text, count) {
    var out = '';
    for (var i = 0; i < count; i++) {
      out += text;
    }
    return out;
  }

  // text padded with spaces to width, on the left when right is true.
  function livPad(text, width, right) {
    var value = String(text);
    var fill = livRepeat(' ', width - value.length);
    return right ? fill + value : value + fill;
  }

  function livUnique(list) {
    return list.filter(function (item, i) {
      return list.indexOf(item) === i;
    });
  }

  function livCount(count, word) {
    return count + ' ' + word + (count === 1 ? '' : 's');
  }

  function livByNumber(a, b) {
    return a - b;
  }

  // Rows of cells as aligned text lines: each column as wide as its widest
  // cell, 'l' or 'r' aligned; a left-aligned last column is not padded.
  function livTable(rows, aligns) {
    var widths = [];
    rows.forEach(function (row) {
      row.forEach(function (cell, c) {
        widths[c] = Math.max(widths[c] || 0, String(cell).length);
      });
    });
    return rows.map(function (row) {
      return row.map(function (cell, c) {
        if (c === row.length - 1 && aligns[c] === 'l') {
          return String(cell);
        }
        return livPad(cell, widths[c], aligns[c] === 'r');
      }).join(' ');
    });
  }

  // A byte count the way ls -h and df -h print it: below 1024 as is, else
  // in K, M, G or T, rounded up, with one decimal below 10.
  function livHumanSize(bytes) {
    if (bytes < 1024) {
      return String(bytes);
    }
    var value = bytes;
    var unit = -1;
    while (value >= 1024 && unit < LIV_UNITS.length - 1) {
      value /= 1024;
      unit++;
    }
    if (value < 10) {
      var tenths = Math.ceil(value * 10);
      return tenths >= 100 ? '10' + LIV_UNITS[unit] : (tenths / 10).toFixed(1) + LIV_UNITS[unit];
    }
    var whole = Math.ceil(value);
    if (whole >= 1024 && unit < LIV_UNITS.length - 1) {
      return '1.0' + LIV_UNITS[unit + 1];
    }
    return whole + LIV_UNITS[unit];
  }

  function livCaseById(id) {
    var found = null;
    LIV_CASES.forEach(function (data) {
      if (data.id === id) {
        found = data;
      }
    });
    return found;
  }

  function livCaseIndex(id) {
    return LIV_CASES.indexOf(livCaseById(id));
  }

  function livProcOf(data, pid) {
    var found = null;
    data.procs.forEach(function (proc) {
      if (proc.pid === pid) {
        found = proc;
      }
    });
    return found;
  }

  // The prompt: user@host:folder$, with the home folder shown as ~.
  function livPrompt(data, cwd) {
    var shown = cwd;
    if (cwd === data.home) {
      shown = '~';
    } else if (cwd.indexOf(data.home + '/') === 0) {
      shown = '~' + cwd.slice(data.home.length);
    }
    return data.user + '@' + data.host + ':' + shown + '$';
  }

  // ── File system (no DOM) ──────────────────────────────────────────────────

  // An absolute, normalised path for input typed in cwd: ~ is home, . and
  // .. are followed, repeated and trailing slashes dropped.
  function livResolve(cwd, home, input) {
    var path = String(input);
    if (path === '~' || path.indexOf('~/') === 0) {
      path = home + path.slice(1);
    } else if (path.charAt(0) !== '/') {
      path = cwd + '/' + path;
    }
    var parts = [];
    path.split('/').forEach(function (part) {
      if (part === '..') {
        parts.pop();
      } else if (part !== '' && part !== '.') {
        parts.push(part);
      }
    });
    return '/' + parts.join('/');
  }

  function livJoin(dir, name) {
    return dir === '/' ? '/' + name : dir + '/' + name;
  }

  // name below a folder as the player typed the folder.
  function livJoinTyped(typed, name) {
    return typed.charAt(typed.length - 1) === '/' ? typed + name : typed + '/' + name;
  }

  function livIsKilled(world, pid) {
    return world.killed.indexOf(pid) !== -1;
  }

  // Whether a killed process took the file with it.
  function livRemoved(data, world, path) {
    return data.procs.some(function (proc) {
      return !!proc.removes && livIsKilled(world, proc.pid) && proc.removes.indexOf(path) !== -1;
    });
  }

  function livFileExists(data, world, path) {
    return livHasOwn(data.files, path) && !livRemoved(data, world, path);
  }

  function livTextSize(lines) {
    return lines.reduce(function (sum, line) {
      return sum + line.length + 1;
    }, 0);
  }

  // Every existing file and listed folder as paths.
  function livAllPaths(data, world) {
    return Object.keys(data.files).filter(function (path) {
      return livFileExists(data, world, path);
    }).concat(Object.keys(data.dirs));
  }

  // The names right below dir, sorted.
  function livChildren(data, world, dir) {
    var prefix = dir === '/' ? '/' : dir + '/';
    var names = [];
    livAllPaths(data, world).forEach(function (path) {
      if (path.indexOf(prefix) === 0 && path.length > prefix.length) {
        names.push(path.slice(prefix.length).split('/')[0]);
      }
    });
    return livUnique(names).sort();
  }

  // { kind: 'file' | 'dir', path, owner, mode, time, size, lines } or null.
  function livEntry(data, world, path) {
    if (livFileExists(data, world, path)) {
      var file = data.files[path];
      var lines = file.lines;
      if (file.afterKill && livIsKilled(world, file.afterKill.pid)) {
        lines = lines.concat(file.afterKill.lines);
      }
      return {
        kind: 'file',
        path: path,
        owner: file.owner || 'root',
        mode: file.mode || '-rw-r--r--',
        time: file.time || data.time,
        size: file.size === undefined ? livTextSize(lines) : file.size,
        lines: lines
      };
    }
    var listed = livHasOwn(data.dirs, path);
    if (path === '/' || listed || livChildren(data, world, path).length) {
      var dir = listed ? data.dirs[path] : {};
      return {
        kind: 'dir',
        path: path,
        owner: dir.owner || 'root',
        mode: dir.mode || 'drwxr-xr-x',
        time: data.time,
        size: 4096,
        lines: []
      };
    }
    return null;
  }

  // The owner's read bit for the user who owns it, the others' bit for
  // everybody else (groups are not modelled).
  function livReadable(entry, user) {
    return entry.mode.charAt(entry.owner === user ? 1 : 7) === 'r';
  }

  // { error: null, entry } or { error: 'missing' | 'denied' | 'notdir' }:
  // every folder on the way must exist and be readable.
  function livAccess(data, world, path) {
    var parts = path.split('/').filter(function (part) {
      return part !== '';
    });
    var at = '/';
    for (var i = 0; i < parts.length; i++) {
      var parent = livEntry(data, world, at);
      if (!parent) {
        return { error: 'missing', entry: null };
      }
      if (parent.kind !== 'dir') {
        return { error: 'notdir', entry: null };
      }
      if (!livReadable(parent, data.user)) {
        return { error: 'denied', entry: null };
      }
      at = livJoin(at, parts[i]);
    }
    var entry = livEntry(data, world, at);
    return entry ? { error: null, entry: entry } : { error: 'missing', entry: null };
  }

  // livAccess for a file to read: also 'isdir', or 'denied' for the file.
  function livOpenFile(data, world, path) {
    var access = livAccess(data, world, path);
    if (access.error) {
      return access;
    }
    if (access.entry.kind === 'dir') {
      return { error: 'isdir', entry: null };
    }
    if (!livReadable(access.entry, data.user)) {
      return { error: 'denied', entry: null };
    }
    return access;
  }

  // Whether path is a folder the user can open.
  function livIsOpenDir(data, world, path) {
    var access = livAccess(data, world, path);
    return !access.error && access.entry.kind === 'dir' && livReadable(access.entry, data.user);
  }

  // The running processes and the file systems, after the kills.
  function livProcesses(data, world) {
    return data.procs.filter(function (proc) {
      return !livIsKilled(world, proc.pid);
    });
  }

  function livMounts(data, world) {
    return data.mounts.map(function (mount) {
      var used = mount.used;
      data.procs.forEach(function (proc) {
        if (proc.frees && proc.frees.mount === mount.mount && livIsKilled(world, proc.pid)) {
          used -= proc.frees.bytes;
        }
      });
      return { fs: mount.fs, size: mount.size, used: used, mount: mount.mount };
    });
  }

  // The file system that holds path: the longest mount point above it.
  function livMountOf(mounts, path) {
    var best = null;
    mounts.forEach(function (mount) {
      var holds = mount.mount === '/' || path === mount.mount || path.indexOf(mount.mount + '/') === 0;
      if (holds && (!best || mount.mount.length > best.mount.length)) {
        best = mount;
      }
    });
    return best;
  }

  // Words with * or ? in their last part become the matching names of
  // that folder (sorted; dot names only for a pattern that starts with a
  // dot), as typed; no match keeps the word, as bash does.
  function livGlob(data, world, word) {
    var slash = word.lastIndexOf('/');
    var dirTyped = word.slice(0, slash + 1);
    var pattern = word.slice(slash + 1);
    var dir = livResolve(world.cwd, data.home, dirTyped || '.');
    if (/[*?]/.test(dirTyped) || !livIsOpenDir(data, world, dir)) {
      return [word];
    }
    var re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    var hits = livChildren(data, world, dir).filter(function (name) {
      return (name.charAt(0) !== '.' || pattern.charAt(0) === '.') && re.test(name);
    });
    return hits.length ? hits.map(function (name) {
      return dirTyped + name;
    }) : [word];
  }

  // ── Parser (no DOM) ───────────────────────────────────────────────────────

  // A command line as { stages: [{ argv, glob }] } (one stage per command
  // of a pipeline; glob[i] tells whether word i had an unquoted * or ?) or
  // { error } worded like bash.  Quotes ' and " group words, a backslash
  // keeps the next character; ; & > < and backquotes are refused.
  function livParse(line) {
    var text = String(line);
    var stages = [];
    var argv = [];
    var glob = [];
    var word = null;
    var wordGlob = false;
    var quote = null;
    var pipeError = 'bash: syntax error near unexpected token `|\'';

    function endWord() {
      if (word !== null) {
        argv.push(word);
        glob.push(wordGlob);
      }
      word = null;
      wordGlob = false;
    }

    function endStage() {
      endWord();
      if (!argv.length) {
        return false;
      }
      stages.push({ argv: argv, glob: glob });
      argv = [];
      glob = [];
      return true;
    }

    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      var next = text.charAt(i + 1);
      if (quote === '\'') {
        if (c === '\'') {
          quote = null;
        } else {
          word += c;
        }
      } else if (quote === '"') {
        if (c === '"') {
          quote = null;
        } else if (c === '\\' && (next === '"' || next === '\\')) {
          word += next;
          i++;
        } else {
          word += c;
        }
      } else if (c === '\'' || c === '"') {
        quote = c;
        word = word === null ? '' : word;
      } else if (c === '\\') {
        word = (word === null ? '' : word) + next;
        i++;
      } else if (c === ' ' || c === '\t') {
        endWord();
      } else if (c === '|') {
        if (!endStage()) {
          return { error: pipeError };
        }
      } else if (LIV_UNSUPPORTED.indexOf(c) !== -1) {
        return { error: 'bash: ' + c + ': not available here: one command per line, with | only into grep or tail' };
      } else {
        wordGlob = wordGlob || c === '*' || c === '?';
        word = (word === null ? '' : word) + c;
      }
    }
    if (quote) {
      return { error: 'bash: unexpected EOF while looking for matching `' + quote + '\'' };
    }
    if (!endStage() && stages.length) {
      return { error: pipeError };
    }
    return { stages: stages };
  }

  // Flags and operands of a command: flags is the letters it knows, valued
  // the letters that take a value (-n 5 or -n5).  -- ends the flags, and a
  // lone - is an operand.  { flags, values, operands, error }.
  function livOptions(cmd, args, flags, valued) {
    var result = { flags: {}, values: {}, operands: [], error: null };
    for (var i = 0; i < args.length; i++) {
      var arg = args[i];
      if (arg === '--') {
        result.operands = result.operands.concat(args.slice(i + 1));
        return result;
      }
      if (arg.length < 2 || arg.charAt(0) !== '-') {
        result.operands.push(arg);
        continue;
      }
      if (arg.charAt(1) === '-') {
        result.error = cmd + ': unrecognized option \'' + arg + '\'';
        return result;
      }
      for (var j = 1; j < arg.length; j++) {
        var c = arg.charAt(j);
        if (valued.indexOf(c) !== -1) {
          var value = arg.slice(j + 1);
          if (value === '') {
            i++;
            if (i >= args.length) {
              result.error = cmd + ': option requires an argument -- \'' + c + '\'';
              return result;
            }
            value = args[i];
          }
          result.values[c] = value;
          break;
        }
        if (flags.indexOf(c) === -1) {
          result.error = cmd + ': invalid option -- \'' + c + '\'';
          return result;
        }
        result.flags[c] = true;
      }
    }
    return result;
  }

  // ── Commands (no DOM) ─────────────────────────────────────────────────────
  //
  // Each takes ctx = { data, world, args, stdin } (stdin: the lines piped
  // in, or null) and returns { out: [{ k, t }], status, world?, reads?,
  // names?, clear? }.  k is 'out' (output), 'err' (errors) or 'sys' (notes
  // from the game, such as the monitor); reads are the files read (for
  // grep: the files with a matching line); names, when given, are what the
  // chips offer (else they come from the output).

  function livOut(text) {
    return { k: 'out', t: text };
  }

  function livErr(text) {
    return { k: 'err', t: text };
  }

  function livSys(text) {
    return { k: 'sys', t: text };
  }

  function livFail(text, status) {
    return { out: [livErr(text)], status: status };
  }

  function livFailWith(result, text, status) {
    result.out.push(livErr(text));
    result.status = status;
  }

  function livUsage(cmd, message) {
    return { out: [livErr(message), livErr('Try \'help ' + cmd + '\' for more information.')], status: 2 };
  }

  function livWorld(world, cwd, killed) {
    return { cwd: cwd, killed: killed, done: world.done.slice() };
  }

  function livLast(lines, count) {
    return lines.slice(Math.max(0, lines.length - count));
  }

  // Whether a result printed output yet (errors aside): a blank line goes
  // before every header but the first.
  function livPrinted(result) {
    return result.out.some(function (item) {
      return item.k === 'out';
    });
  }

  function livLongRow(entry, name, human) {
    return [entry.mode, entry.kind === 'dir' ? '2' : '1', entry.owner, entry.owner,
      human ? livHumanSize(entry.size) : String(entry.size), entry.time, name];
  }

  function livListDir(result, ctx, entry, opts, operand) {
    var data = ctx.data;
    var world = ctx.world;
    var items = livChildren(data, world, entry.path).filter(function (name) {
      return opts.flags.a || name.charAt(0) !== '.';
    }).map(function (name) {
      return { name: name, entry: livEntry(data, world, livJoin(entry.path, name)) };
    });
    items.forEach(function (item) {
      var shown = item.entry.kind === 'dir' ? item.name + '/' : item.name;
      result.names.push(operand === null ? shown : livJoinTyped(operand, shown));
    });
    if (opts.flags.a) {
      items = [
        { name: '.', entry: entry },
        { name: '..', entry: livEntry(data, world, livResolve(entry.path, data.home, '..')) }
      ].concat(items);
    }
    if (opts.flags.l) {
      livTable(items.map(function (item) {
        return livLongRow(item.entry, item.name, opts.flags.h);
      }), LIV_LONG_ALIGN).forEach(function (line) {
        result.out.push(livOut(line));
      });
    } else if (items.length) {
      result.out.push(livOut(items.map(function (item) {
        return item.entry.kind === 'dir' ? item.name + '/' : item.name;
      }).join('  ')));
    }
  }

  function livCmdLs(ctx) {
    var data = ctx.data;
    var world = ctx.world;
    var opts = livOptions('ls', ctx.args, 'lah', '');
    if (opts.error) {
      return livUsage('ls', opts.error);
    }
    var operands = opts.operands.length ? opts.operands : [null];
    var result = { out: [], status: 0, names: [] };
    operands.forEach(function (operand) {
      var typed = operand === null ? '.' : operand;
      var access = livAccess(data, world, livResolve(world.cwd, data.home, typed));
      if (access.error) {
        livFailWith(result, 'ls: cannot access \'' + typed + '\': ' + LIV_REASONS[access.error], 2);
        return;
      }
      var entry = access.entry;
      if (entry.kind === 'file') {
        result.out.push(livOut(opts.flags.l ? livTable([livLongRow(entry, typed, opts.flags.h)], LIV_LONG_ALIGN)[0] : typed));
        result.names.push(typed);
        return;
      }
      if (!livReadable(entry, data.user)) {
        livFailWith(result, 'ls: cannot open directory \'' + typed + '\': Permission denied', 2);
        return;
      }
      if (operands.length > 1) {
        if (livPrinted(result)) {
          result.out.push(livOut(''));
        }
        result.out.push(livOut(typed + ':'));
      }
      livListDir(result, ctx, entry, opts, operand);
    });
    return result;
  }

  function livCmdCd(ctx) {
    var data = ctx.data;
    var world = ctx.world;
    if (ctx.args.length > 1) {
      return livFail('bash: cd: too many arguments', 1);
    }
    var typed = ctx.args.length ? ctx.args[0] : '~';
    var path = livResolve(world.cwd, data.home, typed);
    var access = livAccess(data, world, path);
    var error = access.error;
    if (!error && access.entry.kind !== 'dir') {
      error = 'notdir';
    } else if (!error && !livReadable(access.entry, data.user)) {
      error = 'denied';
    }
    if (error) {
      return livFail('bash: cd: ' + typed + ': ' + LIV_REASONS[error], 1);
    }
    return { out: [], status: 0, world: livWorld(world, path, world.killed.slice()) };
  }

  function livCmdPwd(ctx) {
    return { out: [livOut(ctx.world.cwd)], status: 0 };
  }

  function livCmdCat(ctx) {
    var data = ctx.data;
    var world = ctx.world;
    var opts = livOptions('cat', ctx.args, '', '');
    if (opts.error) {
      return livUsage('cat', opts.error);
    }
    if (!opts.operands.length) {
      return livFail('cat: name a file to print: this shell cannot read from the keyboard', 1);
    }
    var result = { out: [], status: 0, reads: [] };
    opts.operands.forEach(function (typed) {
      var path = livResolve(world.cwd, data.home, typed);
      var open = livOpenFile(data, world, path);
      if (open.error) {
        livFailWith(result, 'cat: ' + typed + ': ' + LIV_REASONS[open.error], 1);
        return;
      }
      open.entry.lines.forEach(function (line) {
        result.out.push(livOut(line));
      });
      result.reads.push(path);
    });
    return result;
  }

  function livCmdTail(ctx) {
    var data = ctx.data;
    var world = ctx.world;
    var args = ctx.args.map(function (arg) {
      return /^-\d+$/.test(arg) ? '-n' + arg.slice(1) : arg;
    });
    var opts = livOptions('tail', args, 'f', 'n');
    if (opts.error) {
      return livUsage('tail', opts.error);
    }
    if (opts.flags.f) {
      return livFail('tail: -f would follow the file forever; this shell prints the last lines once, so leave out -f', 1);
    }
    var count = 10;
    if (livHasOwn(opts.values, 'n')) {
      if (!/^\d+$/.test(opts.values.n)) {
        return livFail('tail: invalid number of lines: \'' + opts.values.n + '\'', 1);
      }
      count = Number(opts.values.n);
    }
    if (!opts.operands.length) {
      if (ctx.stdin === null) {
        return livFail('tail: name a file: this shell cannot read from the keyboard', 1);
      }
      return { out: livLast(ctx.stdin, count).map(livOut), status: 0, reads: [] };
    }
    var result = { out: [], status: 0, reads: [] };
    var multi = opts.operands.length > 1;
    opts.operands.forEach(function (typed) {
      var path = livResolve(world.cwd, data.home, typed);
      var open = livOpenFile(data, world, path);
      if (open.error === 'isdir') {
        livFailWith(result, 'tail: error reading \'' + typed + '\': Is a directory', 1);
        return;
      }
      if (open.error) {
        livFailWith(result, 'tail: cannot open \'' + typed + '\' for reading: ' + LIV_REASONS[open.error], 1);
        return;
      }
      if (multi) {
        if (livPrinted(result)) {
          result.out.push(livOut(''));
        }
        result.out.push(livOut('==> ' + typed + ' <=='));
      }
      livLast(open.entry.lines, count).forEach(function (line) {
        result.out.push(livOut(line));
      });
      result.reads.push(path);
    });
    return result;
  }

  // The files below the open folder dir for grep -r, walked name by name:
  // { path, entry } for a file, { path, error: 'denied' } for a file or a
  // folder the user cannot read (grep does not go into that folder).
  function livFilesUnder(data, world, dir) {
    var items = [];
    livChildren(data, world, dir).forEach(function (name) {
      var path = livJoin(dir, name);
      var entry = livEntry(data, world, path);
      var readable = livReadable(entry, data.user);
      if (entry.kind === 'dir' && readable) {
        items = items.concat(livFilesUnder(data, world, path));
      } else {
        items.push({ path: path, entry: readable ? entry : null, error: readable ? null : 'denied' });
      }
    });
    return items;
  }

  function livCmdGrep(ctx) {
    var data = ctx.data;
    var world = ctx.world;
    var opts = livOptions('grep', ctx.args, 'inrv', '');
    if (opts.error) {
      return livUsage('grep', opts.error);
    }
    if (!opts.operands.length) {
      return livUsage('grep', 'Usage: grep [OPTION]... PATTERNS [FILE]...');
    }
    var flags = opts.flags;
    var pattern = flags.i ? opts.operands[0].toLowerCase() : opts.operands[0];
    var files = opts.operands.slice(1);
    var result = { out: [], status: 0, reads: [] };
    var errors = false;

    function scan(lines, label) {
      var hit = false;
      lines.forEach(function (line, k) {
        var found = (flags.i ? line.toLowerCase() : line).indexOf(pattern) !== -1;
        if (found !== !!flags.v) {
          hit = true;
          result.out.push(livOut((label === null ? '' : label + ':') + (flags.n ? (k + 1) + ':' : '') + line));
        }
      });
      return hit;
    }

    if (!files.length && ctx.stdin !== null) {
      result.status = scan(ctx.stdin, null) ? 0 : 1;
      return result;
    }
    if (!files.length && !flags.r) {
      return livFail('grep: name a file to search: this shell cannot read from the keyboard', 2);
    }
    var operands = files.length ? files : [''];
    var labelled = operands.length > 1 || !!flags.r;
    operands.forEach(function (typed) {
      var path = livResolve(world.cwd, data.home, typed);
      var open = livOpenFile(data, world, path);
      if (open.error === 'isdir' && flags.r) {
        if (!livIsOpenDir(data, world, path)) {
          result.out.push(livErr('grep: ' + typed + ': Permission denied'));
          errors = true;
          return;
        }
        var prefix = path === '/' ? '/' : path + '/';
        livFilesUnder(data, world, path).forEach(function (item) {
          var rest = item.path.slice(prefix.length);
          var label = typed === '' ? rest : livJoinTyped(typed, rest);
          if (item.error) {
            result.out.push(livErr('grep: ' + label + ': ' + LIV_REASONS[item.error]));
            errors = true;
          } else if (scan(item.entry.lines, label)) {
            result.reads.push(item.path);
          }
        });
        return;
      }
      if (open.error) {
        result.out.push(livErr('grep: ' + typed + ': ' + LIV_REASONS[open.error]));
        errors = true;
        return;
      }
      if (scan(open.entry.lines, labelled ? typed : null)) {
        result.reads.push(path);
      }
    });
    result.status = errors ? 2 : (result.reads.length ? 0 : 1);
    return result;
  }

  function livCmdPs(ctx) {
    var data = ctx.data;
    var args = ctx.args;
    var full = args.length === 1 && /^(-?[aux]+|-ef?)$/.test(args[0]);
    if (args.length && !full) {
      return livFail('ps: unsupported option \'' + args.join(' ') + '\': this shell knows ps and ps aux', 1);
    }
    if (!full) {
      return {
        out: livTable([['PID', 'TTY', 'TIME', 'CMD'], [data.shellPid, 'pts/0', '00:00:00', 'bash'],
          [data.psPid, 'pts/0', '00:00:00', 'ps']], ['r', 'l', 'l', 'l']).map(livOut),
        status: 0,
        names: []
      };
    }
    var rows = [[data.user, data.psPid, '0.0', '0.1', 'ps ' + args[0]]];
    var names = [];
    livProcesses(data, ctx.world).forEach(function (proc) {
      rows.push([proc.user, proc.pid, proc.cpu.toFixed(1), proc.mem.toFixed(1), proc.cmd]);
      if (proc.pid !== data.shellPid) {
        names.push(String(proc.pid));
      }
    });
    rows.sort(function (a, b) {
      return a[1] - b[1];
    });
    rows.unshift(['USER', 'PID', '%CPU', '%MEM', 'COMMAND']);
    return { out: livTable(rows, ['l', 'r', 'r', 'r', 'l']).map(livOut), status: 0, names: names };
  }

  function livCmdDf(ctx) {
    var data = ctx.data;
    var world = ctx.world;
    var opts = livOptions('df', ctx.args, 'h', '');
    if (opts.error) {
      return livUsage('df', opts.error);
    }
    var mounts = livMounts(data, world);
    var result = { out: [], status: 0, names: [] };
    var shown = opts.operands.length ? [] : mounts;
    opts.operands.forEach(function (typed) {
      var path = livResolve(world.cwd, data.home, typed);
      var access = livAccess(data, world, path);
      if (access.error) {
        livFailWith(result, 'df: ' + typed + ': ' + LIV_REASONS[access.error], 1);
        return;
      }
      var mount = livMountOf(mounts, path);
      if (shown.indexOf(mount) === -1) {
        shown.push(mount);
      }
    });
    if (!shown.length) {
      return result;
    }
    var human = !!opts.flags.h;
    var size = human ? livHumanSize : function (bytes) {
      return String(Math.ceil(bytes / 1024));
    };
    var rows = [human ? ['Filesystem', 'Size', 'Used', 'Avail', 'Use%', 'Mounted on'] :
      ['Filesystem', '1K-blocks', 'Used', 'Available', 'Use%', 'Mounted on']];
    shown.forEach(function (mount) {
      rows.push([mount.fs, size(mount.size), size(mount.used), size(mount.size - mount.used),
        Math.ceil(mount.used * 100 / mount.size) + '%', mount.mount]);
      result.names.push(mount.mount);
    });
    result.out = result.out.concat(livTable(rows, ['l', 'r', 'r', 'r', 'r', 'l']).map(livOut));
    return result;
  }

  // The signal for 9, KILL, kill or SIGKILL, or null.
  function livSignal(spec) {
    var wanted = String(spec).toUpperCase().replace(/^SIG(?=[A-Z])/, '');
    var found = null;
    LIV_SIGNALS.forEach(function (signal) {
      if (signal.num === wanted || signal.name === wanted) {
        found = signal;
      }
    });
    return found;
  }

  // kill -l: every signal, or the name of each number and the number of
  // each name given.
  function livKillList(args) {
    if (!args.length) {
      return { out: [livOut(LIV_SIGNALS.map(function (signal) {
        return signal.num + ') SIG' + signal.name;
      }).join('  '))], status: 0 };
    }
    var result = { out: [], status: 0 };
    args.forEach(function (arg) {
      var signal = livSignal(arg);
      if (!signal) {
        livFailWith(result, 'bash: kill: ' + arg + ': invalid signal specification', 1);
        return;
      }
      result.out.push(livOut(/^\d+$/.test(arg) ? signal.name : signal.num));
    });
    return result;
  }

  function livCmdKill(ctx) {
    var data = ctx.data;
    var args = ctx.args.slice();
    var first = args.length ? args[0] : '';
    var spec = null;
    if (first === '-l') {
      return livKillList(args.slice(1));
    }
    if (first === '-s' || first === '-n') {
      args.shift();
      if (!args.length) {
        return livFail('bash: kill: ' + first + ': option requires an argument', 2);
      }
      spec = args.shift();
    } else if (first.length > 1 && first.charAt(0) === '-') {
      spec = args.shift().slice(1);
    }
    if (spec !== null && !livSignal(spec)) {
      return livFail('bash: kill: ' + spec + ': invalid signal specification', 1);
    }
    if (!args.length) {
      return livFail(LIV_KILL_USAGE, 2);
    }
    var killed = ctx.world.killed.slice();
    var result = { out: [], status: 0, world: null };
    args.forEach(function (arg) {
      if (!/^\d+$/.test(arg)) {
        livFailWith(result, 'bash: kill: ' + arg + ': arguments must be process or job IDs', 1);
        return;
      }
      var pid = Number(arg);
      var proc = livProcOf(data, pid);
      if (!proc || killed.indexOf(pid) !== -1) {
        livFailWith(result, 'bash: kill: (' + arg + ') - No such process', 1);
        return;
      }
      if (pid === data.shellPid) {
        result.out.push(livSys('# ' + pid + ' is your own shell (' + proc.cmd + '): killing it would only log you out, so it keeps running.'));
        return;
      }
      if (proc.user !== data.user) {
        livFailWith(result, 'bash: kill: (' + arg + ') - Operation not permitted', 1);
        return;
      }
      killed.push(pid);
      (proc.onKill || []).forEach(function (text) {
        result.out.push(livSys(text));
      });
    });
    result.world = livWorld(ctx.world, ctx.world.cwd, killed);
    return result;
  }

  function livCmdHelp(ctx) {
    if (!ctx.args.length) {
      return { out: LIV_HELP_ALL.map(livOut), status: 0 };
    }
    var topic = ctx.args[0];
    if (!livHasOwn(LIV_HELP, topic)) {
      return livFail('bash: help: no help topics match \'' + topic + '\'. Type help alone for the list.', 1);
    }
    return { out: LIV_HELP[topic].map(livOut), status: 0 };
  }

  function livCmdClear() {
    return { out: [], status: 0, clear: true };
  }

  var LIV_COMMANDS = {
    cat: livCmdCat,
    cd: livCmdCd,
    clear: livCmdClear,
    df: livCmdDf,
    grep: livCmdGrep,
    help: livCmdHelp,
    kill: livCmdKill,
    ls: livCmdLs,
    ps: livCmdPs,
    pwd: livCmdPwd,
    tail: livCmdTail
  };

  // A command this shell does not have.
  function livUnknown(data, name) {
    if (LIV_DELETERS.indexOf(name) !== -1) {
      return { out: [livErr('bash: ' + name + ': command not found'),
        livSys('# Deleting files is not your call on this shift: find the cause and stop it.')], status: 127 };
    }
    if (name === 'sudo') {
      return livFail(data.user + ' is not in the sudoers file.  This incident will be reported.', 1);
    }
    return { out: [livErr('bash: ' + name + ': command not found'),
      livSys('# This shell knows: ' + LIV_COMMAND_NAMES.join(' ') + '. Type help for their flags.')], status: 127 };
  }

  // ── Running a line (no DOM) ───────────────────────────────────────────────

  // The names the chips offer from output lines: process ids of ps rows and
  // of "pid 1234", and absolute paths; at most LIV_NAMES_MAX, no repeats.
  function livNamesIn(texts) {
    var names = [];
    texts.forEach(function (text) {
      var row = LIV_PS_ROW.exec(text);
      if (row) {
        names.push(row[1]);
      }
      text.replace(LIV_PATH_RE, function (all, lead, path) {
        names.push(path);
        return all;
      });
      text.replace(LIV_PID_RE, function (all, pid) {
        names.push(pid);
        return all;
      });
    });
    return livUnique(names).slice(0, LIV_NAMES_MAX);
  }

  // Whether a goal is met after a line: its commands (events), the world
  // they left and the output lines it showed (shown).
  function livGoalMet(goal, world, events, shown) {
    var test = goal.test;
    if (livHasOwn(test, 'killed')) {
      return livIsKilled(world, test.killed);
    }
    if (livHasOwn(test, 'cwd')) {
      return world.cwd === test.cwd;
    }
    var ran = events.some(function (event) {
      return (!test.run || event.name === test.run) &&
        (test.read ? event.reads.indexOf(test.read) !== -1 : !!test.saw || event.status === 0);
    });
    return ran && (!test.saw || shown.some(function (text) {
      return text.indexOf(test.saw) !== -1;
    }));
  }

  // world with the goals met by the events and output of a line added to
  // done.
  function livWithGoals(data, world, events, shown) {
    var done = world.done.slice();
    data.goals.forEach(function (goal, i) {
      if (done.indexOf(i) === -1 && livGoalMet(goal, world, events, shown)) {
        done.push(i);
      }
    });
    return { cwd: world.cwd, killed: world.killed.slice(), done: done.sort(livByNumber) };
  }

  // Whether every goal of the case is met.
  function livCheckWin(data, world) {
    return data.goals.every(function (goal, i) {
      return world.done.indexOf(i) !== -1;
    });
  }

  // Runs one command line against the case: { world, out, names, clear,
  // counted, status }.  A pipeline feeds each command's output lines to the
  // next (only grep and tail read a pipe); errors and notes of earlier
  // commands show as they come.  As in bash, every command of a pipeline
  // runs in a subshell: a cd there leaves this shell where it was (a note
  // says so), while a kill still stops its process.  counted is false for
  // empty lines and for help and clear alone; every refused line counts.
  function livRun(data, world, line) {
    var parsed = livParse(line);
    var start = { cwd: world.cwd, killed: world.killed.slice(), done: world.done.slice() };
    var result = { world: start, out: [], names: [], clear: false, counted: false, status: 0 };
    if (parsed.error) {
      result.out = [livErr(parsed.error)];
      result.counted = true;
      result.status = 2;
      return result;
    }
    var stages = parsed.stages;
    if (!stages.length) {
      return result;
    }
    result.counted = stages.some(function (stage) {
      return LIV_UNCOUNTED.indexOf(stage.argv[0]) === -1;
    });
    for (var s = 1; s < stages.length; s++) {
      if (LIV_PIPE_READERS.indexOf(stages[s].argv[0]) === -1) {
        result.out = [livErr('bash: ' + stages[s].argv[0] + ': cannot read a pipe here: only grep and tail can')];
        result.counted = true;
        result.status = 2;
        return result;
      }
    }
    var current = start;
    var piped = stages.length > 1;
    var stdin = null;
    var events = [];
    var last = null;
    stages.forEach(function (stage, k) {
      var argv = [];
      stage.argv.forEach(function (word, i) {
        argv = argv.concat(i > 0 && stage.glob[i] ? livGlob(data, current, word) : [word]);
      });
      var name = argv[0];
      var run = livHasOwn(LIV_COMMANDS, name) ? LIV_COMMANDS[name] : null;
      last = run ? run({ data: data, world: current, args: argv.slice(1), stdin: stdin }) : livUnknown(data, name);
      if (last.world) {
        current = { cwd: piped ? current.cwd : last.world.cwd, killed: last.world.killed, done: current.done };
        if (piped && name === 'cd') {
          result.out.push(livSys('# cd ran in a subshell of the pipeline, so this shell stays in ' + current.cwd + '.'));
        }
      }
      events.push({ name: name, status: last.status, reads: last.reads || [] });
      if (k === stages.length - 1) {
        result.out = result.out.concat(last.out);
        return;
      }
      stdin = [];
      last.out.forEach(function (item) {
        if (item.k === 'out') {
          stdin.push(item.t);
        } else {
          result.out.push(item);
        }
      });
    });
    result.world = livWithGoals(data, current, events, result.out.filter(function (item) {
      return item.k === 'out';
    }).map(function (item) {
      return item.t;
    }));
    result.status = last.status;
    result.clear = !!last.clear;
    result.names = last.names ? livUnique(last.names).slice(0, LIV_NAMES_MAX) : livNamesIn(last.out.map(function (item) {
      return item.t;
    }));
    return result;
  }

  // ── Completion and history (no DOM) ───────────────────────────────────────

  function livCommonPrefix(list) {
    var first = list[0];
    var length = first.length;
    list.forEach(function (item) {
      var i = 0;
      while (i < length && item.charAt(i) === first.charAt(i)) {
        i++;
      }
      length = i;
    });
    return first.slice(0, length);
  }

  // Tab on line: { line, options, miss }.  The first word (or the word
  // after a |, spaced or not) completes to a command name, any other word
  // to a name in its folder (folders end in /, a whole name gets a space).
  // Several options extend the word to what they share and are listed in
  // options; none leaves the line and says why in miss.
  function livComplete(data, world, line) {
    var cut = Math.max(line.lastIndexOf(' '), line.lastIndexOf('|'));
    var before = line.slice(0, cut + 1);
    var word = line.slice(cut + 1);
    var head = before.replace(/\s+$/, '');
    var typedDir = '';
    var options;
    var miss;
    if (head === '' || head.charAt(head.length - 1) === '|') {
      options = LIV_COMMAND_NAMES.filter(function (name) {
        return name.indexOf(word) === 0;
      });
      miss = 'No command starts with \'' + word + '\'. Type help for the list.';
    } else {
      var slash = word.lastIndexOf('/');
      typedDir = word.slice(0, slash + 1);
      var prefix = word.slice(slash + 1);
      var dir = livResolve(world.cwd, data.home, typedDir || '.');
      var names = livIsOpenDir(data, world, dir) ? livChildren(data, world, dir) : [];
      options = names.filter(function (name) {
        return name.indexOf(prefix) === 0 && (name.charAt(0) !== '.' || prefix.charAt(0) === '.');
      }).map(function (name) {
        return livEntry(data, world, livJoin(dir, name)).kind === 'dir' ? name + '/' : name;
      });
      miss = 'Nothing in ' + dir + ' starts with \'' + prefix + '\'.';
    }
    if (!options.length) {
      return { line: line, options: [], miss: miss };
    }
    if (options.length === 1) {
      var only = options[0];
      return { line: before + typedDir + only + (only.charAt(only.length - 1) === '/' ? '' : ' '), options: [], miss: null };
    }
    return { line: before + typedDir + livCommonPrefix(options), options: options, miss: null };
  }

  // One step through the history (dir -1 older, +1 newer): { pos, draft,
  // text }.  pos === history.length is the line being typed (the draft),
  // which is kept while older lines are shown.
  function livHistoryMove(history, pos, draft, current, dir) {
    var from = Math.min(pos, history.length);
    var to = Math.max(0, Math.min(history.length, from + dir));
    var keep = from === history.length ? current : draft;
    return { pos: to, draft: keep, text: to === history.length ? keep : history[to] };
  }

  // history with line added (not twice in a row), the last LIV_HISTORY_MAX.
  function livRemember(history, line) {
    var out = history[history.length - 1] === line ? history.slice() : history.concat([line]);
    return out.slice(-LIV_HISTORY_MAX);
  }

  // The command line after a chip: add goes after a space.
  function livJoinInput(current, add) {
    return current === '' || /\s$/.test(current) ? current + add : current + ' ' + add;
  }

  // ── Score (no DOM) ────────────────────────────────────────────────────────

  function livMistakes(data, world) {
    return world.killed.filter(function (pid) {
      return livProcOf(data, pid).keep === true;
    }).length;
  }

  function livScore(data, commands, hints, mistakes) {
    var points = LIV_POINTS_START - LIV_POINTS_EXTRA * Math.max(0, commands - data.par) -
      LIV_POINTS_HINT * hints - LIV_POINTS_MISTAKE * mistakes;
    return Math.max(LIV_POINTS_FLOOR, points);
  }

  // ── Saves (no DOM) ────────────────────────────────────────────────────────

  function livParseJson(text) {
    if (typeof text !== 'string') {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  function livIsObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function livIsCount(value, max) {
    return typeof value === 'number' && Math.floor(value) === value && value >= 0 && value <= max;
  }

  function livFreshSession(data) {
    return { cwd: data.home, killed: [], done: [], history: [], commands: 0, hints: 0 };
  }

  // One case's session from a save, field by field: killed holds only the
  // user's own processes (never the shell), cwd a folder the user can open,
  // done the goals of the case (and every goal a kill meets), history the
  // last LIV_HISTORY_MAX lines; commands falls back to the history length
  // and hints to 0.
  function livParseSession(data, raw) {
    var session = livFreshSession(data);
    if (!livIsObject(raw)) {
      return session;
    }
    if (Array.isArray(raw.killed)) {
      raw.killed.forEach(function (pid) {
        var proc = livProcOf(data, pid);
        if (proc && pid !== data.shellPid && proc.user === data.user && session.killed.indexOf(pid) === -1) {
          session.killed.push(pid);
        }
      });
    }
    var cwd = raw.cwd;
    if (typeof cwd === 'string' && livResolve('/', data.home, cwd) === cwd && livIsOpenDir(data, session, cwd)) {
      session.cwd = cwd;
    }
    if (Array.isArray(raw.done)) {
      raw.done.forEach(function (i) {
        if (livIsCount(i, data.goals.length - 1) && session.done.indexOf(i) === -1) {
          session.done.push(i);
        }
      });
    }
    session.done = livWithGoals(data, session, [], []).done;
    if (Array.isArray(raw.history)) {
      session.history = raw.history.filter(function (line) {
        return typeof line === 'string' && line !== '' && line.length <= LIV_LINE_MAX;
      }).slice(-LIV_HISTORY_MAX);
    }
    session.commands = livIsCount(raw.commands, LIV_COUNT_MAX) ? raw.commands : session.history.length;
    session.hints = livIsCount(raw.hints, data.hints.length) ? raw.hints : 0;
    return session;
  }

  // liv-state: { caseId, sessions } with a session for every case.
  function livParseState(text) {
    var raw = livParseJson(text);
    var data = livIsObject(raw) ? raw : {};
    var sessions = livIsObject(data.sessions) ? data.sessions : {};
    var state = { caseId: livCaseById(data['case']) ? data['case'] : LIV_CASES[0].id, sessions: {} };
    LIV_CASES.forEach(function (one) {
      state.sessions[one.id] = livParseSession(one, livHasOwn(sessions, one.id) ? sessions[one.id] : null);
    });
    return state;
  }

  function livSerializeState(state) {
    var sessions = {};
    LIV_CASES.forEach(function (one) {
      var s = state.sessions[one.id];
      sessions[one.id] = { cwd: s.cwd, killed: s.killed, done: s.done, history: s.history, commands: s.commands, hints: s.hints };
    });
    return JSON.stringify({ v: LIV_SAVE_VERSION, 'case': state.caseId, sessions: sessions });
  }

  // liv-progress: case id -> { score, commands, hints } for solved cases.
  // An entry needs a score from 10 to 100; a bad commands or hints count
  // alone becomes null.
  function livParseProgress(text) {
    var raw = livParseJson(text);
    var cases = livIsObject(raw) && livIsObject(raw.cases) ? raw.cases : {};
    var progress = {};
    LIV_CASES.forEach(function (one) {
      var entry = livHasOwn(cases, one.id) ? cases[one.id] : null;
      if (!livIsObject(entry) || !livIsCount(entry.score, LIV_POINTS_START) || entry.score < LIV_POINTS_FLOOR) {
        return;
      }
      progress[one.id] = {
        score: entry.score,
        commands: livIsCount(entry.commands, LIV_COUNT_MAX) ? entry.commands : null,
        hints: livIsCount(entry.hints, one.hints.length) ? entry.hints : null
      };
    });
    return progress;
  }

  // The better entry of each case: the higher score, a's on a tie.
  function livMergeProgress(a, b) {
    var merged = {};
    LIV_CASES.forEach(function (one) {
      var ours = livHasOwn(a, one.id) ? a[one.id] : null;
      var theirs = livHasOwn(b, one.id) ? b[one.id] : null;
      var best = !theirs || (ours && ours.score >= theirs.score) ? ours : theirs;
      if (best) {
        merged[one.id] = best;
      }
    });
    return merged;
  }

  function livSerializeProgress(progress) {
    var cases = {};
    LIV_CASES.forEach(function (one) {
      var entry = progress[one.id];
      if (entry) {
        cases[one.id] = { score: entry.score, commands: entry.commands, hints: entry.hints };
      }
    });
    return JSON.stringify({ v: LIV_SAVE_VERSION, cases: cases });
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  // The warning for every key whose storage failed so far, naming each key
  // and what it holds; '' when none did.
  function livStorageWarning(failed) {
    var parts = [];
    ['blocked', 'full'].forEach(function (kind) {
      var hit = LIV_SAVED.filter(function (item) {
        return failed[item.key] === kind;
      });
      if (!hit.length) {
        return;
      }
      var keys = hit.map(function (item) {
        return item.key;
      }).join(' and ');
      var what = hit.map(function (item) {
        return item.what;
      }).join(' and ');
      parts.push(kind === 'blocked'
        ? 'Browser storage is blocked: ' + keys + ' cannot be read or saved, so ' + what + ' will not be kept after a reload.'
        : 'Browser storage is full: ' + keys + (hit.length > 1 ? ' were' : ' was') +
          ' not saved, so a reload loses the latest changes to ' + what + '.');
    });
    return parts.join(' ');
  }

  function livStorageFailed(error, key) {
    livRuntime.failed[key] = /quota/i.test(String(error.name)) ? 'full' : 'blocked';
    var warning = livRuntime.els.warning;
    warning.textContent = livStorageWarning(livRuntime.failed);
    warning.classList.remove('liv-hidden');
  }

  function livStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      livStorageFailed(error, key);
      return null;
    }
  }

  function livStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      livStorageFailed(error, key);
      return false;
    }
  }

  function livData() {
    return livCaseById(livState.caseId);
  }

  function livSession() {
    return livState.sessions[livState.caseId];
  }

  // Writes liv-state; stateText follows only what really reached storage,
  // so a failed write never makes the stored text look like another tab's.
  function livSaveState() {
    var text = livSerializeState(livState);
    if (livStorageSet(LIV_STATE_KEY, text)) {
      livRuntime.stateText = text;
    }
  }

  // Takes over the liv-state another tab wrote since this tab last read or
  // wrote it.  The case on screen stays.  A note tells in every terminal
  // whose session changed: at once for the case on screen, and at the end
  // of the kept lines of another case, so switching to it never shows an
  // old screen without a trace.  Returns whether it took one over.
  function livSyncState() {
    var text = livStorageGet(LIV_STATE_KEY);
    if (text === null || text === livRuntime.stateText) {
      return false;
    }
    livRuntime.stateText = text;
    var before = {};
    LIV_CASES.forEach(function (one) {
      before[one.id] = JSON.stringify(livState.sessions[one.id]);
    });
    livState.sessions = livParseState(text).sessions;
    LIV_CASES.forEach(function (one) {
      var session = livState.sessions[one.id];
      if (JSON.stringify(session) === before[one.id]) {
        return;
      }
      var note = livSys('# Another tab changed this case: ' + livCount(session.commands, 'command') +
        ' so far, now in ' + session.cwd + '.');
      if (one.id === livState.caseId) {
        livRuntime.names = [];
        livResetHistory();
        livAppendLines([note]);
      } else if (livRuntime.screens[one.id]) {
        livRuntime.screens[one.id] = livRuntime.screens[one.id].concat([note]).slice(-LIV_SCREEN_MAX);
      }
    });
    livRender();
    return true;
  }

  // Keeps entry as the case's result when it beats the stored one, merged
  // with what another tab may have stored.  Returns whether it did.
  function livRecordProgress(id, entry) {
    var single = {};
    single[id] = entry;
    var stored = livParseProgress(livStorageGet(LIV_PROGRESS_KEY));
    livState.progress = livMergeProgress(livMergeProgress(livState.progress, stored), single);
    livStorageSet(LIV_PROGRESS_KEY, livSerializeProgress(livState.progress));
    return livState.progress[id] === entry;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function livElement(tag, className, text) {
    var el = document.createElement(tag);
    el.className = className;
    el.textContent = text;
    return el;
  }

  function livChip(label, className, attr, value, aria) {
    var chip = livElement('button', className, label);
    chip.setAttribute('type', 'button');
    chip.setAttribute(attr, value);
    chip.setAttribute('aria-label', aria);
    return chip;
  }

  function livLineElement(line) {
    return livElement('div', 'liv-line liv-line--' + line.k, line.t);
  }

  // The first lines of a case's terminal: its motd, and a note when a
  // saved session goes on.
  function livOpeningLines(data, session) {
    var lines = data.motd.map(livSys);
    if (session.history.length) {
      lines.push(livSys('# Session restored: ' + livCount(session.commands, 'command') + ' so far, in ' +
        session.cwd + '. Up brings back your history.'));
    }
    return lines;
  }

  function livScreenLines() {
    var id = livState.caseId;
    if (!livRuntime.screens[id]) {
      livRuntime.screens[id] = livOpeningLines(livData(), livSession());
    }
    return livRuntime.screens[id];
  }

  function livDrawScreen() {
    var el = livRuntime.els.screen;
    el.textContent = '';
    livScreenLines().forEach(function (line) {
      el.appendChild(livLineElement(line));
    });
    el.scrollTop = el.scrollHeight;
  }

  // Adds lines to the terminal of the case on screen, keeping the last
  // LIV_SCREEN_MAX.
  function livAppendLines(lines) {
    var screen = livScreenLines();
    var el = livRuntime.els.screen;
    lines.forEach(function (line) {
      screen.push(line);
      el.appendChild(livLineElement(line));
    });
    while (screen.length > LIV_SCREEN_MAX) {
      screen.shift();
      el.removeChild(el.firstChild);
    }
    el.scrollTop = el.scrollHeight;
  }

  function livSetStatus(text) {
    livRuntime.els.status.textContent = text;
  }

  function livHideToast() {
    livRuntime.toastTimeout = null;
    livRuntime.els.toast.classList.remove('liv-show');
  }

  // Shows message for LIV_TOAST_MS; a newer toast gets its full time.
  function livShowToast(message) {
    var toast = livRuntime.els.toast;
    clearTimeout(livRuntime.toastTimeout);
    toast.textContent = message;
    toast.classList.add('liv-show');
    livRuntime.toastTimeout = setTimeout(livHideToast, LIV_TOAST_MS);
  }

  function livResetHistory() {
    livRuntime.historyPos = livSession().history.length;
    livRuntime.draft = '';
  }

  function livCaseMeta(index) {
    var data = LIV_CASES[index];
    var entry = livState.progress[data.id];
    var session = livState.sessions[data.id];
    if (entry) {
      return 'Solved: ' + entry.score + ' points';
    }
    return session.commands ? 'In progress: ' + livCount(session.commands, 'command') : 'New';
  }

  function livRenderCases() {
    livRuntime.caseButtons.forEach(function (button, i) {
      var data = LIV_CASES[i];
      var meta = livCaseMeta(i);
      button.children[2].textContent = meta;
      button.setAttribute('aria-pressed', String(data.id === livState.caseId));
      button.setAttribute('aria-label', 'Case ' + (i + 1) + ': ' + data.title + ', ' + meta);
      button.classList.toggle('liv-case-btn--solved', livHasOwn(livState.progress, data.id));
    });
  }

  function livRenderGoals(data, session) {
    var key = JSON.stringify([data.id, session.done]);
    if (key === livRuntime.goalsKey) {
      return;
    }
    livRuntime.goalsKey = key;
    var list = livRuntime.els.goals;
    var next = -1;
    list.textContent = '';
    data.goals.forEach(function (goal, i) {
      var done = session.done.indexOf(i) !== -1;
      if (!done && next === -1) {
        next = i;
      }
      var item = livElement('li', 'liv-goal' + (done ? ' liv-goal--done' : (next === i ? ' liv-goal--next' : '')), '');
      item.appendChild(livElement('span', 'liv-goal-mark', done ? '[x]' : '[ ]'));
      item.appendChild(livElement('span', 'liv-goal-text', goal.text));
      if (goal.example && !done) {
        item.appendChild(livChip(goal.example, 'liv-chip liv-chip--example', 'data-fill', goal.example, 'Type ' + goal.example));
      }
      list.appendChild(item);
    });
  }

  function livRenderHints(data, session) {
    var key = JSON.stringify([data.id, session.hints]);
    if (key === livRuntime.hintsKey) {
      return;
    }
    livRuntime.hintsKey = key;
    var list = livRuntime.els.hints;
    list.textContent = '';
    list.classList.toggle('liv-hidden', !session.hints);
    data.hints.slice(0, session.hints).forEach(function (hint, i) {
      var item = livElement('li', 'liv-hint-item', '');
      item.appendChild(livElement('span', 'liv-hint-text', 'Hint ' + (i + 1) + ': ' + hint.text));
      item.appendChild(livChip(hint.example, 'liv-chip liv-chip--example', 'data-fill', hint.example, 'Type ' + hint.example));
      list.appendChild(item);
    });
  }

  function livRenderNames() {
    var names = livRuntime.names;
    var key = names.join('\n');
    if (key === livRuntime.namesKey) {
      return;
    }
    livRuntime.namesKey = key;
    var els = livRuntime.els;
    els.names.textContent = '';
    els.namesRow.classList.toggle('liv-hidden', !names.length);
    names.forEach(function (name) {
      els.names.appendChild(livChip(name, 'liv-chip liv-chip--name', 'data-add', name, 'Add ' + name));
    });
  }

  function livScoreText(data, session, won) {
    var mistakes = livMistakes(data, session);
    var entry = livState.progress[data.id];
    var record = entry ? ' · record ' + entry.score : '';
    var parts = livCount(session.commands, 'command') + ' (par ' + data.par + ') · hints ' + session.hints + '/' +
      data.hints.length + ' · ' + livCount(mistakes, 'wrong kill');
    if (won) {
      return 'Solved: ' + livScore(data, session.commands, session.hints, mistakes) + ' points · ' + parts + record;
    }
    return parts + record;
  }

  function livHintLabel(data, session) {
    if (!data.hints.length) {
      return 'No hints here';
    }
    if (session.hints >= data.hints.length) {
      return 'No hints left';
    }
    return 'Hint ' + (session.hints + 1) + '/' + data.hints.length + ' (-10)';
  }

  function livRender() {
    var els = livRuntime.els;
    var data = livData();
    var session = livSession();
    var index = livCaseIndex(data.id);
    var won = livCheckWin(data, session);
    var next = LIV_CASES[index + 1];
    els.caseTitle.textContent = 'Case ' + (index + 1) + ': ' + data.title;
    els.brief.textContent = data.brief;
    els.termTitle.textContent = data.user + '@' + data.host;
    els.prompt.textContent = livPrompt(data, session.cwd);
    els.score.textContent = livScoreText(data, session, won);
    els.hint.textContent = livHintLabel(data, session);
    els.hint.disabled = won || session.hints >= data.hints.length;
    els.restart.textContent = livRuntime.confirming ? 'Press again to restart' : 'Restart case';
    els.next.classList.toggle('liv-hidden', !(won && next));
    els.next.textContent = next ? 'Next case: ' + next.title : 'Next case';
    livRenderGoals(data, session);
    livRenderHints(data, session);
    livRenderNames();
    livRenderCases();
  }

  function livCaseLabel(data) {
    return 'case ' + (livCaseIndex(data.id) + 1) + ' (' + data.title + ')';
  }

  // ── Game flow ─────────────────────────────────────────────────────────────

  function livWin(data, session) {
    var mistakes = livMistakes(data, session);
    var score = livScore(data, session.commands, session.hints, mistakes);
    var improved = livRecordProgress(data.id, { score: score, commands: session.commands, hints: session.hints });
    var summary = score + ' points: ' + livCount(session.commands, 'command') + ' (par ' + data.par + '), ' +
      livCount(session.hints, 'hint') + ', ' + livCount(mistakes, 'wrong kill');
    livAppendLines(data.win.map(function (text) {
      return { k: 'win', t: text };
    }).concat([livSys('# Score: ' + summary + '.')]));
    livSetStatus('Case closed with ' + summary + '.' + (improved ? ' New record.' :
      ' Your record stays ' + livState.progress[data.id].score + ' points.'));
    livShowToast('Case closed: ' + score + ' points');
  }

  // Runs a line typed or tapped in: echo, output, goals, the command count
  // (frozen once the case is closed), the save.
  function livRunLine(line) {
    livSyncState();
    var data = livData();
    var session = livSession();
    var text = line.trim();
    var echo = { k: 'cmd', t: livPrompt(data, session.cwd) + (text ? ' ' + text : '') };
    if (!text) {
      livAppendLines([echo]);
      livResetHistory();
      return;
    }
    var wasWon = livCheckWin(data, session);
    var result = livRun(data, session, text);
    session.history = livRemember(session.history, text);
    session.cwd = result.world.cwd;
    session.killed = result.world.killed;
    session.done = result.world.done;
    if (result.counted && !wasWon) {
      session.commands = Math.min(LIV_COUNT_MAX, session.commands + 1);
    }
    livResetHistory();
    livRuntime.names = result.names;
    if (result.clear) {
      livRuntime.screens[data.id] = [];
      livDrawScreen();
    } else {
      livAppendLines([echo].concat(result.out));
    }
    if (!wasWon && livCheckWin(data, session)) {
      livWin(data, session);
    }
    livSaveState();
    livRender();
  }

  function livSubmit() {
    var input = livRuntime.els.input;
    var line = input.value;
    input.value = '';
    livRunLine(line);
  }

  function livCompleteInput() {
    var data = livData();
    var session = livSession();
    var input = livRuntime.els.input;
    var before = input.value;
    var result = livComplete(data, session, before);
    input.value = result.line;
    if (result.options.length) {
      livAppendLines([{ k: 'cmd', t: livPrompt(data, session.cwd) + ' ' + before }, livOut(result.options.join('  '))]);
    } else if (result.miss) {
      livShowToast(result.miss);
    }
  }

  function livBrowse(dir) {
    var input = livRuntime.els.input;
    var move = livHistoryMove(livSession().history, livRuntime.historyPos, livRuntime.draft, input.value, dir);
    livRuntime.historyPos = move.pos;
    livRuntime.draft = move.draft;
    input.value = move.text;
  }

  function livBrowseUp() {
    livBrowse(-1);
  }

  function livBrowseDown() {
    livBrowse(1);
  }

  function livShowHint() {
    livSyncState();
    var data = livData();
    var session = livSession();
    if (livCheckWin(data, session) || session.hints >= data.hints.length) {
      livRender();
      return;
    }
    var hint = data.hints[session.hints];
    session.hints += 1;
    livAppendLines([livSys('# Hint ' + session.hints + '/' + data.hints.length + ' (-10 points): ' + hint.text)]);
    livSaveState();
    livRender();
    livSetStatus('Hint ' + session.hints + ' of ' + livCaseLabel(data) + ' shown: it costs 10 points when you close the case.');
  }

  function livCancelConfirm() {
    clearTimeout(livRuntime.confirmTimeout);
    livRuntime.confirmTimeout = null;
    livRuntime.confirming = false;
  }

  function livConfirmExpired() {
    livRuntime.confirmTimeout = null;
    livRuntime.confirming = false;
    livRender();
    livSetStatus('Restart cancelled: ' + livCaseLabel(livData()) + ' goes on.');
  }

  // What a restart keeps: the hints seen, which still cost their points.
  function livHintsKept(session) {
    return session.hints ? ', and the hints you saw (' + session.hints + ') still cost 10 points each' : '';
  }

  // Restart: a fresh copy of the case's server; the hints already seen stay
  // seen, so a restart never makes them free.  A session with commands
  // that is not closed yet needs a second press within LIV_CONFIRM_MS.
  function livRestart() {
    livSyncState();
    var data = livData();
    var session = livSession();
    if (!livRuntime.confirming && session.commands > 0 && !livCheckWin(data, session)) {
      livRuntime.confirming = true;
      livRuntime.confirmTimeout = setTimeout(livConfirmExpired, LIV_CONFIRM_MS);
      livRender();
      livSetStatus('Restart ' + livCaseLabel(data) + '? Press Restart again within 4 s to drop its ' +
        livCount(session.commands, 'command') + livHintsKept(session) + '.');
      return;
    }
    livCancelConfirm();
    var fresh = livFreshSession(data);
    fresh.hints = session.hints;
    livState.sessions[data.id] = fresh;
    livRuntime.screens[data.id] = null;
    livRuntime.names = [];
    livResetHistory();
    livDrawScreen();
    livAppendLines([livSys('# Case restarted on a fresh copy of ' + data.host + livHintsKept(session) + '.')]);
    livSaveState();
    livRender();
    livSetStatus('Restarted ' + livCaseLabel(data) + ' on a fresh copy of ' + data.host + livHintsKept(session) + '.');
  }

  function livSelectCase(id) {
    livSyncState();
    livCancelConfirm();
    livState.caseId = id;
    var data = livData();
    livRuntime.names = [];
    livRuntime.els.input.value = '';
    livResetHistory();
    livDrawScreen();
    livSaveState();
    livRender();
    livSetStatus('Now on ' + livCaseLabel(data) + ', logged in to ' + data.host + ' as ' + data.user + '.');
  }

  function livNext() {
    var next = LIV_CASES[livCaseIndex(livState.caseId) + 1];
    if (next) {
      livSelectCase(next.id);
    }
  }

  function livWelcomeText() {
    var data = livData();
    var session = livSession();
    if (livCheckWin(data, session)) {
      return 'Case closed with ' + livScore(data, session.commands, session.hints, livMistakes(data, session)) +
        ' points. Pick another case, or Restart case to play it again.';
    }
    return 'Type a command and press Enter, or tap the chips under the terminal. help lists the commands.';
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  // Keys reach this listener only from the command field.  A held Enter
  // or Tab acts once; held arrows keep browsing.
  function livHandleKeydown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented) {
      return;
    }
    var key = event.key;
    if (key === 'Enter') {
      event.preventDefault();
      if (!event.repeat) {
        livSubmit();
      }
    } else if ((key === 'ArrowUp' || key === 'ArrowDown') && !event.shiftKey) {
      event.preventDefault();
      livBrowse(key === 'ArrowUp' ? -1 : 1);
    } else if (key === 'Tab' && !event.shiftKey && livRuntime.els.input.value !== '') {
      event.preventDefault();
      if (!event.repeat) {
        livCompleteInput();
      }
    }
  }

  // The kind of pointer that pressed a chip last (mouse, pen or touch).
  function livHandlePointerDown(event) {
    livRuntime.pointer = event.pointerType;
  }

  // A chip types its command (data-fill) or adds a name (data-add).  After
  // a mouse or keyboard click the command field gets the focus back, so
  // Enter runs the line; after a tap it stays away from the field, so the
  // on-screen keyboard does not open over the chips.
  function livHandleChipClick(event) {
    var chip = event.target.closest('.liv-chip');
    var touch = (event.pointerType || livRuntime.pointer) === 'touch';
    livRuntime.pointer = '';
    if (!chip) {
      return;
    }
    var input = livRuntime.els.input;
    var fill = chip.getAttribute('data-fill');
    var value = fill === null ? livJoinInput(input.value, chip.getAttribute('data-add')) : fill;
    if (value.length > LIV_LINE_MAX) {
      livShowToast('The command line holds at most ' + LIV_LINE_MAX + ' characters: run it or clear it first.');
      return;
    }
    input.value = value;
    if (!touch) {
      input.focus();
    }
  }

  function livHandleCaseClick(event) {
    var button = event.target.closest('.liv-case-btn');
    if (button) {
      livSelectCase(button.getAttribute('data-case'));
    }
  }

  // Another tab wrote to storage: its sessions are taken over, its scores
  // merged in.
  function livHandleStorage(event) {
    if (event.key === LIV_STATE_KEY) {
      livSyncState();
    } else if (event.key === LIV_PROGRESS_KEY) {
      livState.progress = livMergeProgress(livState.progress, livParseProgress(livStorageGet(LIV_PROGRESS_KEY)));
      livRender();
    }
  }

  function livBuildChips() {
    var box = livRuntime.els.chips;
    LIV_CHIPS.forEach(function (def) {
      var fill = livHasOwn(def, 'fill');
      box.appendChild(livChip(def.label, 'liv-chip', fill ? 'data-fill' : 'data-add', fill ? def.fill : def.add,
        (fill ? 'Type ' : 'Add ') + def.label));
    });
  }

  function livBuildCases() {
    var box = livRuntime.els.cases;
    LIV_CASES.forEach(function (data, i) {
      var button = livElement('button', 'liv-case-btn', '');
      button.setAttribute('type', 'button');
      button.setAttribute('data-case', data.id);
      button.appendChild(livElement('span', 'liv-case-num', 'Case ' + (i + 1)));
      button.appendChild(livElement('span', 'liv-case-name', data.title));
      button.appendChild(livElement('span', 'liv-case-meta', ''));
      box.appendChild(button);
      livRuntime.caseButtons.push(button);
    });
  }

  function livBindEvents() {
    var els = livRuntime.els;
    els.input.addEventListener('keydown', livHandleKeydown);
    els.run.addEventListener('click', livSubmit);
    els.complete.addEventListener('click', livCompleteInput);
    els.histUp.addEventListener('click', livBrowseUp);
    els.histDown.addEventListener('click', livBrowseDown);
    els.hint.addEventListener('click', livShowHint);
    els.restart.addEventListener('click', livRestart);
    els.next.addEventListener('click', livNext);
    els.cases.addEventListener('click', livHandleCaseClick);
    [els.chips, els.names, els.goals, els.hints].forEach(function (box) {
      box.addEventListener('pointerdown', livHandlePointerDown);
      box.addEventListener('click', livHandleChipClick);
    });
    window.addEventListener('storage', livHandleStorage);
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  function livFindElements() {
    return {
      cases: document.getElementById('liv-cases'),
      caseTitle: document.getElementById('liv-case-title'),
      brief: document.getElementById('liv-brief'),
      goals: document.getElementById('liv-goals'),
      hints: document.getElementById('liv-hints'),
      score: document.getElementById('liv-score'),
      hint: document.getElementById('liv-hint'),
      restart: document.getElementById('liv-restart'),
      next: document.getElementById('liv-next'),
      termTitle: document.getElementById('liv-term-title'),
      screen: document.getElementById('liv-screen'),
      prompt: document.getElementById('liv-prompt'),
      input: document.getElementById('liv-input'),
      chips: document.getElementById('liv-chips'),
      namesRow: document.getElementById('liv-names-row'),
      names: document.getElementById('liv-names'),
      histUp: document.getElementById('liv-hist-up'),
      histDown: document.getElementById('liv-hist-down'),
      complete: document.getElementById('liv-complete'),
      run: document.getElementById('liv-run'),
      status: document.getElementById('liv-status'),
      warning: document.getElementById('liv-warning'),
      toast: document.getElementById('liv-toast')
    };
  }

  // Finds the elements, builds the chips and case buttons, binds the
  // controls once and restores the saves.  Nothing is written until the
  // first command, hint, restart or case change.
  function livInit() {
    if (livRuntime.els) {
      return;
    }
    livRuntime.els = livFindElements();
    livRuntime.stateText = livStorageGet(LIV_STATE_KEY);
    var saved = livParseState(livRuntime.stateText);
    livState.caseId = saved.caseId;
    livState.sessions = saved.sessions;
    livState.progress = livParseProgress(livStorageGet(LIV_PROGRESS_KEY));
    livBuildChips();
    livBuildCases();
    livBindEvents();
    livResetHistory();
    livDrawScreen();
    livRender();
    livSetStatus(livWelcomeText());
  }

  // Node (tests): export only, no init and no timers.  Browser: init once the
  // markup is there.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      livState: livState,
      livRuntime: livRuntime,
      livInit: livInit,
      livCases: LIV_CASES,
      livCommandNames: LIV_COMMAND_NAMES,
      livChips: LIV_CHIPS,
      livHelpAll: LIV_HELP_ALL,
      livHelp: LIV_HELP,
      livParse: livParse,
      livOptions: livOptions,
      livResolve: livResolve,
      livEntry: livEntry,
      livChildren: livChildren,
      livAccess: livAccess,
      livGlob: livGlob,
      livHumanSize: livHumanSize,
      livTable: livTable,
      livPrompt: livPrompt,
      livProcesses: livProcesses,
      livMounts: livMounts,
      livMountOf: livMountOf,
      livCmdLs: livCmdLs,
      livCmdCd: livCmdCd,
      livCmdPwd: livCmdPwd,
      livCmdCat: livCmdCat,
      livCmdTail: livCmdTail,
      livCmdGrep: livCmdGrep,
      livCmdPs: livCmdPs,
      livCmdDf: livCmdDf,
      livCmdKill: livCmdKill,
      livCmdHelp: livCmdHelp,
      livCmdClear: livCmdClear,
      livUnknown: livUnknown,
      livNamesIn: livNamesIn,
      livRun: livRun,
      livCheckWin: livCheckWin,
      livComplete: livComplete,
      livHistoryMove: livHistoryMove,
      livRemember: livRemember,
      livJoinInput: livJoinInput,
      livMistakes: livMistakes,
      livScore: livScore,
      livFreshSession: livFreshSession,
      livParseSession: livParseSession,
      livParseState: livParseState,
      livSerializeState: livSerializeState,
      livParseProgress: livParseProgress,
      livMergeProgress: livMergeProgress,
      livSerializeProgress: livSerializeProgress,
      livStorageWarning: livStorageWarning
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', livInit);
  } else {
    livInit();
  }
})();
