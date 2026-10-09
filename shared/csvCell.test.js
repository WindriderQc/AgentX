'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { csvCell, browserModuleSource, browserGlobalSource } = require('./csvCell');

// [value, separator, expected cell]
const CASES = [
  [null, ',', ''],
  [undefined, ',', ''],
  ['plain', ',', 'plain'],
  ['a,b', ',', '"a,b"'],
  ['a,b', ';', 'a,b'],
  ['a;b', ';', '"a;b"'],
  ['say "hi"', ',', '"say ""hi"""'],
  ['two\nlines', ',', '"two\nlines"'],
  ['=SUM(A1)', ',', "'=SUM(A1)"],
  ['=HYPERLINK("http://x","go")', ',', '"\'=HYPERLINK(""http://x"",""go"")"'],
  ['+1', ',', "'+1"],
  ['@cmd', ',', "'@cmd"],
  ['-cmd', ',', "'-cmd"],
  [' =1+1', ',', "' =1+1"],
  ['\n=1+1', ',', '"\'\n=1+1"'],
  ['\tx', ',', "'\tx"],
  ['\rx', ',', '"\'\rx"'],
  ['-1', ',', '-1'],
  ['-12.50', ',', '-12.50'],
  ['-149,41', ';', '-149,41'],
  ['-149,41', ',', '"-149,41"'],
  [-1.5, ',', '-1.5'],
  [0, ',', '0'],
  [true, ',', 'true']
];

function check(fn) {
  for (const [value, separator, expected] of CASES) {
    assert.equal(fn(value, separator), expected, JSON.stringify([value, separator]));
  }
}

test('the Node helper neutralizes formulas and quotes only when needed', () => {
  check(csvCell);
  assert.equal(csvCell('a,b'), '"a,b"');
});

test('the browser ES module is the same function', async () => {
  const mod = await import(`data:text/javascript,${encodeURIComponent(browserModuleSource())}`);
  check(mod.csvCell);
});

test('the browser global script is the same function', () => {
  const context = { window: {} };
  vm.runInNewContext(browserGlobalSource(), context);
  check(context.window.AgentXCsvCell);
});
