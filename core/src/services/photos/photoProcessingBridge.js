'use strict';
// Core talks directly to its fixed NAS capability; no phone host is involved.
const { execFile } = require('node:child_process'), { promisify } = require('node:util');
const { fail } = require('./importFiles');
const { loadProcessingConfig } = require('./photoProcessingConfig');
function createPhotoProcessingBridge({ config = loadProcessingConfig, runner = promisify(execFile) } = {}) {
  async function call(input) {
    const fixed = config();
    if (!fixed) throw fail('PHOTO_PROCESSING_NOT_CONFIGURED', 'Configure the verified-import photo pipeline');
    const encoded = Buffer.from(JSON.stringify(input)).toString('base64');
    if (encoded.length > 90000) throw fail('INVALID_QUERY', 'Photo command exceeds its bound');
    let reply;
    try {
      reply = await runner('ssh', ['-T', '-n', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
        '-o', 'IdentitiesOnly=yes', '-i', fixed.identityFile, '-o', 'UserKnownHostsFile='+fixed.knownHostsFile,
        fixed.sshTarget, encoded], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      if (!error.stdout) throw fail('PHOTO_PROCESSING_UNAVAILABLE', 'NAS result unavailable; retain the same operation identity');
      reply = { stdout: error.stdout };
    }
    let value;
    try { value = JSON.parse(reply.stdout); }
    catch { throw fail('PHOTO_PROCESSING_UNAVAILABLE', 'NAS returned no usable photo receipt'); }
    if (!value.ok) throw fail(value.error?.code || 'PHOTO_PROCESSING_UNAVAILABLE', value.error?.message || 'Photo operation unavailable');
    return value.data;
  }
  return { call };
}
module.exports = { createPhotoProcessingBridge };
