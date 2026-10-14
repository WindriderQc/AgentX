'use strict';

const fs = require('node:fs');

// DSH 0.2 stores settings in profile configuration. A launch overlay keeps
// managed values effective on every restart, beyond the one-time YAML import.
function settingsPatch(settings) {
  const renamed = { 'ui-onboarding': 'ui-settings-general', 'ui-developer-tools': 'ui-settings' };
  return Object.entries(settings).map(([id, config]) => ({ id: renamed[id] || id, config }));
}

if (require.main === module) {
  const [source, destination, dshRoot] = process.argv.slice(2);
  const yaml = require(require.resolve('js-yaml', { paths: [dshRoot] }));
  const settings = yaml.load(fs.readFileSync(source, 'utf8')) || {};
  fs.writeFileSync(destination, JSON.stringify(settingsPatch(settings), null, 2) + '\n', { mode: 0o600 });
}

module.exports = { settingsPatch };
