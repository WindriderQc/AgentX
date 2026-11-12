'use strict';
// Run through launchWorker on Windows against a disposable receiver. This
// checks the real headless WMI/SSH/SCP path, without opening any phone.
const fs = require('node:fs/promises'), path = require('node:path');
const { createRemote } = require('../transport.cjs');
const { checkpoint } = require('../import.cjs');
(async () => {
  if (process.platform !== 'win32') throw new Error('Windows-only native qualification');
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--run')
    throw new Error('Use --config <disposable receiver config> --run <qualification UUID>');
  const config = JSON.parse(await fs.readFile(args[1], 'utf8'));
  const result = path.join(config.cacheRoot, 'file-transport-' + args[3] + '.json');
  if (!/^[a-f0-9-]{36}$/.test(args[3]) || !path.isAbsolute(config.cacheRoot))
    throw new Error('Absolute private cache and qualification identity required');
  // Exclusive intent refuses replay if the result of a prior probe is lost.
  const intent = await fs.open(result + '.intent', 'wx', 0o600);
  try { await intent.writeFile(JSON.stringify({ requestId: args[3], phoneReads: 0 })); await intent.sync(); }
  finally { await intent.close(); }
  const remote = createRemote(config);
  for (let i = 0; i < 12; i++) {
    await checkpoint(result + '.progress', { next: i, total: 12 });
    const answer = await remote({ action: 'ping' });
    if (answer.schema !== 'agentx.photo-import/v1' || !answer.ready) throw new Error('Invalid receiver ping');
  }
  await checkpoint(result, { completed: 12, wmiSurvivedSshLogout: true, phoneReads: 0, phoneDeletes: 0 });
})().catch(error => { console.error(error.message); process.exitCode = 1; });
