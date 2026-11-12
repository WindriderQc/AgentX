#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises'),
  path = require('node:path');
const { createWpd, createRemote, lockCache } = require('./transport.cjs');
const { runImport, checkpoint } = require('./import.cjs');
const { createRemover } = require('./cleanup-transport.cjs');
const { executePhoneCleanup } = require('../../core/src/services/photos/phoneCleanupExecution');
const { createPhoneWorkbench } = require('../../core/src/services/photos/phoneWorkbench');

async function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!['--config', '--command', '--run', '--ssh'].includes(process.argv[i]) || !process.argv[i + 1])
      throw new Error('Invalid workbench command');
    args[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  if (args.ssh) {
    if (args.ssh !== 'forced' || args.command || args.run)
      throw new Error('Invalid forced collector entrance');
    const original = process.env.SSH_ORIGINAL_COMMAND || '';
    if (!/^[A-Za-z0-9+/]{1,5998}={0,2}$/.test(original))
      throw new Error('Only a bounded encoded phone command is accepted');
    args.command = original;
  }
  if (!args.config || Boolean(args.command) === Boolean(args.run))
    throw new Error('Specify --config and one command or run identity');
  const config = JSON.parse(await fs.readFile(args.config, 'utf8'));
  if (!path.isAbsolute(config.cacheRoot || '')) throw new Error('Configure an absolute staging root');
  await fs.mkdir(config.cacheRoot, { recursive: true, mode: 0o700 });
  const native = createPhoneWorkbench({
    config,
    source: createWpd(config.cacheRoot),
    remote: createRemote(config),
    importer: runImport,
    cleanup: (options) => executePhoneCleanup({ ...options, remove: createRemover(config.cacheRoot) }),
    checkpoint,
    lock: lockCache,
    alive: async (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    launch: (requestId) =>
      require('./launch.cjs').launchWorker({
        requestId,
        configFile: args.config,
        cacheRoot: config.cacheRoot,
        worker: __filename,
      }),
  });
  const result = args.run
    ? await native.run(args.run)
    : await native.command(JSON.parse(Buffer.from(args.command, 'base64').toString('utf8')));
  process.stdout.write(JSON.stringify({ ok: true, data: result }) + '\n');
}
if (require.main === module)
  main().catch((e) => {
    process.stdout.write(
      JSON.stringify({ ok: false, error: { code: e.code || 'PHONE_UNAVAILABLE', message: e.message } }) +
        '\n',
    );
    process.exitCode = 1;
  });
module.exports = { main };
