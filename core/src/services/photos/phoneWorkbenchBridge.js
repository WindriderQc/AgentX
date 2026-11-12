'use strict';

const fs = require('node:fs/promises'),
  path = require('node:path');
const { execFile } = require('node:child_process'),
  { promisify } = require('node:util');
const exec = promisify(execFile);
const { fail } = require('./importFiles');

function createPhoneWorkbenchBridge(options = {}) {
  const env = options.env || process.env;
  const runner =
    options.runner ||
    ((target, command, config) =>
      exec(
        'ssh',
        [
          '-T',
          '-o',
          'BatchMode=yes',
          '-o',
          'StrictHostKeyChecking=yes',
          '-o',
          'ConnectTimeout=8',
          '-o',
          'ServerAliveInterval=10',
          '-o',
          'ServerAliveCountMax=3',
          ...(config.identityFile ? ['-i', config.identityFile, '-o', 'IdentitiesOnly=yes'] : []),
          ...(config.knownHostsFile ? ['-o', 'UserKnownHostsFile=' + config.knownHostsFile] : []),
          target,
          command,
        ],
        { timeout: 45000, maxBuffer: 16 * 1024 * 1024 },
      ));
  async function call(input) {
    let config = options.config;
    if (!config) {
      if (!env.AGENTX_INSTANCE_ROOT)
        throw fail('PHONE_NOT_CONFIGURED', 'Configure the Android collector before using this workbench');
      try {
        config = JSON.parse(
          await fs.readFile(
            path.join(env.AGENTX_INSTANCE_ROOT, 'config', 'photo-import', 'workbench.json'),
            'utf8',
          ),
        );
      } catch (e) {
        if (e.code === 'ENOENT')
          throw fail('PHONE_NOT_CONFIGURED', 'The Android collector is not configured');
        throw e;
      }
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(config.sshTarget || ''))
      throw fail('INVALID_CONFIGURATION', 'Invalid collector SSH target');
    for (const file of [config.identityFile, config.knownHostsFile].filter((x) => x !== undefined)) {
      if (typeof file !== 'string' || !path.isAbsolute(file) || /[\r\n\0]/.test(file))
        throw fail('INVALID_CONFIGURATION', 'Invalid collector identity path');
    }
    for (const file of [config.worker, config.clientConfig]) {
      if (typeof file !== 'string' || !/^\w:[\\/]/.test(file) || /["%!?&|<>^\r\n\0]/.test(file))
        throw fail('INVALID_CONFIGURATION', 'Invalid Windows collector path');
    }
    const encoded = Buffer.from(JSON.stringify(input)).toString('base64');
    if (encoded.length > 6000) throw fail('INVALID_QUERY', 'Request exceeds the native command bound');
    // Windows cmd receives only quoted operator-owned paths and base64 JSON.
    // No browser-supplied path, executable or shell fragment is accepted.
    const command =
      config.forcedCommand === true
        ? encoded
        : `node "${config.worker}" --config "${config.clientConfig}" --command ${encoded}`;
    let result;
    try {
      result = await runner(config.sshTarget, command, config);
    } catch (e) {
      if (e.stdout) result = { stdout: e.stdout };
      else
        throw fail(
          'PHONE_UNAVAILABLE',
          'Collector unavailable; reconnect its host and reconcile the original operation',
        );
    }
    let reply;
    try {
      reply = JSON.parse(typeof result === 'string' ? result : result.stdout);
    } catch {
      throw fail(
        'PHONE_UNAVAILABLE',
        'Collector returned no usable result; retain the original operation identity',
      );
    }
    if (!reply.ok)
      throw fail(reply.error?.code || 'PHONE_UNAVAILABLE', reply.error?.message || 'Collector unavailable');
    return reply.data;
  }
  return { call };
}
module.exports = { createPhoneWorkbenchBridge };
