'use strict';

const { SecretaryMailControl, SecretaryMailError } = require('./secretary-mail-control');
const ID = /^[a-f0-9]{10,32}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

// Destinations belong to the operator. A request selects neither a host nor an
// archive path, and an absent mirror must never fall back to the primary host.
class SecretaryPreservationControl {
  constructor(options = {}) {
    const mirrorTarget = process.env.SECRETARY_ARCHIVE_MIRROR_SSH_TARGET;
    const mirrorRoot = process.env.SECRETARY_ARCHIVE_MIRROR_REMOTE_ROOT;
    this.primary = options.primary || new SecretaryMailControl();
    this.mirror = options.mirror || (mirrorTarget && mirrorRoot
      ? new SecretaryMailControl({ sshTarget: mirrorTarget, remoteRoot: mirrorRoot }) : null);
  }

  async probe(copy, input) { return this.read(copy, input, 'preservation'); }

  async probeRestoration(copy, input) { return this.read(copy, input, 'restoration'); }

  async read(copy, { requestId, messageId, threadId, sourceSha256 } = {}, command) {
    if (![requestId, messageId, threadId, sourceSha256].every(value => typeof value === 'string')
      || !['preservation', 'restoration'].includes(command)
      || !['primary', 'mirror'].includes(copy) || !UUID.test(requestId || '') || !ID.test(messageId || '')
      || !ID.test(threadId || '') || !HASH.test(sourceSha256 || '')) {
      throw new SecretaryMailError('Choose an exact native preservation source.', { code: 'SECRETARY_PRESERVATION_INVALID', statusCode: 400 });
    }
    const reader = this[copy];
    if (!reader || !reader.available) throw new SecretaryMailError('This native archive copy is not configured.', {
      code: 'SECRETARY_PRESERVATION_UNAVAILABLE', statusCode: 503
    });
    return reader.call(`${command} --message ${messageId} --thread ${threadId} --sha256 ${sourceSha256} --request-id ${requestId}`);
  }
}

module.exports = { SecretaryPreservationControl };
