// tests/run.js
// Entry point for `npm test`.  `node --test tests/` only works on Node 20
// (Node 21+ treats the directory as a module path), quoted globs only work on
// Node 21+, and cmd.exe never expands unquoted ones — so collect the test
// files ourselves and hand them to node:test's run(), which behaves the same
// on every supported Node version and platform.  The spec reporter is used on
// every Node version (a bare `node --test` prints TAP on Node 20 when the
// output is not a terminal; pass --test-reporter=spec there for the same
// output).
//
// `npm run coverage` (node tests/run.js --coverage) runs the same files with
// node:test's code coverage for every game's script.js (*/script.js, relative
// to the repo root) and prints the coverage table after the test report.  It
// uses run()'s coverage / coverageIncludeGlobs options and the
// lineCoverage / branchCoverage / functionCoverage thresholds, which exist
// from Node 22.10.0 (and 23.0.0) on; an older Node gets a message naming that
// version and exit code 1.  A total below its threshold makes run() print
// "Error: <n>% line coverage does not meet threshold of <m>%." just above the
// table and exit with code 1.  Plain `npm test` has no thresholds and still
// runs on Node 20.11+.
//
// Every test fails after TEST_TIMEOUT_MS, so a test that waits on a promise
// that never settles fails the run instead of hanging the CI build.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { run } = require('node:test');
const { spec } = require('node:test/reporters');

const COVERAGE_MIN = [22, 10, 0];
const COVERAGE_GLOBS = ['*/script.js'];

// The coverage floors: the totals of */script.js measured on 2026-11-04
// (100 % lines, 100 % branches, 100 % functions), rounded down to a whole
// percent.  Update them when the measured totals change.
const COVERAGE_THRESHOLDS = { lineCoverage: 100, branchCoverage: 100, functionCoverage: 100 };

// The tests take milliseconds each; a minute means something hangs.
const TEST_TIMEOUT_MS = 60000;

const coverage = process.argv.slice(2).includes('--coverage');

function atLeast(version, min) {
  const parts = version.split('.').map(Number);
  for (let i = 0; i < min.length; i++) {
    if (parts[i] !== min[i]) return parts[i] > min[i];
  }
  return true;
}

if (coverage && !atLeast(process.versions.node, COVERAGE_MIN)) {
  console.error(
    'npm run coverage needs Node ' + COVERAGE_MIN.join('.') + ' or newer (node:test run() ' +
    'coverage options); this is Node ' + process.versions.node + '. ' +
    'Plain `npm test` works on Node 20.11+.'
  );
  process.exit(1);
}

const files = fs.readdirSync(__dirname)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(__dirname, name));

if (files.length === 0) {
  console.error('No *.test.js files found in ' + __dirname);
  process.exit(1);
}

const options = { files, timeout: TEST_TIMEOUT_MS };
if (coverage) {
  // Globs match paths relative to the working directory: run from the repo
  // root, whatever directory npm or the caller started in.
  process.chdir(path.join(__dirname, '..'));
  options.coverage = true;
  options.coverageIncludeGlobs = COVERAGE_GLOBS;
  Object.assign(options, COVERAGE_THRESHOLDS);
}

run(options)
  .on('test:fail', (data) => {
    if (!data.todo) process.exitCode = 1;
  })
  .compose(new spec())
  .pipe(process.stdout);
