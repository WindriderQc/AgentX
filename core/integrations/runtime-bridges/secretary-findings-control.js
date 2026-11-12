'use strict';

const { SecretaryMailControl, SecretaryMailError } = require('./secretary-mail-control');
const ID = /^[a-f0-9]{10,32}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

class SecretaryFindingsControl {
  constructor(options = {}) { this.reader = options.reader || new SecretaryMailControl(); }

  async probe({ requestId, messageId, threadId, sourceSha256 } = {}) {
    if (![requestId, messageId, threadId, sourceSha256].every(value => typeof value === 'string')
      || !UUID.test(requestId) || !ID.test(messageId) || !ID.test(threadId) || !HASH.test(sourceSha256)) {
      throw new SecretaryMailError('Choose an exact recorded finding source.', { code: 'SECRETARY_FINDINGS_INVALID', statusCode: 400 });
    }
    if (!this.reader.available) throw new SecretaryMailError('The native finding reader is unavailable.', {
      code: 'SECRETARY_FINDINGS_UNAVAILABLE', statusCode: 503
    });
    return this.reader.call(`findings --message ${messageId} --thread ${threadId} --sha256 ${sourceSha256} --request-id ${requestId}`);
  }
}

module.exports = { SecretaryFindingsControl };
