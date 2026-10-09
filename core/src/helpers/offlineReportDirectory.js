'use strict';

const fs = require('node:fs');
const path = require('node:path');

function realPath(target) {
  const missing = [];
  let current = path.resolve(target);
  while (!fs.existsSync(current) && path.dirname(current) !== current) {
    missing.unshift(path.basename(current));
    current = path.dirname(current);
  }
  return path.join(fs.realpathSync.native(current), ...missing);
}

function reportDirectory(out, { appRoot = path.resolve(__dirname, '../..') } = {}) {
  const target = realPath(out);
  const relative = path.relative(realPath(appRoot), target);
  const refuse = () => new Error('--out must be outside the checkout and the application directory: the report holds private request text');
  if (!relative || (!(relative === '..' || relative.startsWith(`..${path.sep}`)) && !path.isAbsolute(relative))) throw refuse();
  for (let directory = target; ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, '.git'))) throw refuse();
    if (path.dirname(directory) === directory) break;
  }
  if (fs.existsSync(path.join(target, 'summary.json'))) throw new Error('--out already holds a report; choose a new directory');
  return target;
}

module.exports = { reportDirectory };
