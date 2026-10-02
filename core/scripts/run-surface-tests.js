'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function testFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? testFiles(filename) : entry.name.endsWith('.test.js') ? [filename] : [];
  }).sort();
}

for (const component of ['surfaces/household', 'surfaces/data-toolbox', 'surfaces/psyx', 'integrations/runtime-bridges']) {
  const cwd = path.join(__dirname, '..', component);
  // Node's default discovery also executes support servers in test/ directories.
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), ...testFiles(path.join(cwd, 'test'))], {
    cwd,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
