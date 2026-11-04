// tests/run.js
// Entry point for `npm test`.  `node --test tests/` only works on Node 20
// (Node 21+ treats the directory as a module path), quoted globs only work on
// Node 21+, and cmd.exe never expands unquoted ones — so collect the test
// files ourselves and hand them to node:test's run(), which behaves the same
// on every supported Node version and platform.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { run } = require('node:test');
const { spec } = require('node:test/reporters');

const files = fs.readdirSync(__dirname)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(__dirname, name));

if (files.length === 0) {
  console.error('No *.test.js files found in ' + __dirname);
  process.exit(1);
}

run({ files })
  .on('test:fail', (data) => {
    if (!data.todo) process.exitCode = 1;
  })
  .compose(new spec())
  .pipe(process.stdout);
