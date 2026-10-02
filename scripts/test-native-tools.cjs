'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const tests = [
  [process.execPath, ['--test', ...['codex-usage-sync', 'alert-governance-sweep', 'sync-openclaw-schedule', 'native-data-collectors-verifier', 'alert-telegram-relay'].map(name => `integrations/operations/tests/${name}.test.js`)]],
  [process.execPath, ['--test', 'shared/envStatus.test.js', 'scripts/env-catalog.test.cjs']],
  [process.execPath, ['--test', 'integrations/openclaw/gmail-secretary/test/index.test.js', 'integrations/openclaw/gmail-secretary/test/triage-rules.test.js','integrations/openclaw/dsh-coding-agent/test/index.test.js', 'integrations/openclaw/jobs/subscriptions/test/subscription-audit.test.js']],
  [process.execPath, ['--test', 'integrations/openclaw/jobs/overseer/test/wrapper.test.js', 'integrations/openclaw/jobs/overseer/test/postcondition.test.js']],
  ...['secretary', 'memory-review', 'coding', 'openclaw/jobs'].map(name => [process.env.AGENTX_PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'), ['-m', 'unittest', 'discover', '-s', `integrations/${name}/tests`, '-v']])
];
for (const [command, args] of tests) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
