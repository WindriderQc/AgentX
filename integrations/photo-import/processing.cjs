#!/usr/bin/env node
'use strict';
// Fixed NAS-side Core entrance: callers provide identities, never file paths.
const fs = require('node:fs/promises');
const { createPhotoProjection } = require('../../core/src/services/photos/photoProjection');
const { createPhoneLibrary, id } = require('../../core/src/services/photos/phoneLibrary');
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--config' || !['--command', '--ssh'].includes(args[2]))
    throw new Error('Specify trusted configuration and one encoded command');
  const encoded = args[2] === '--ssh' && args[3] === 'forced' ? process.env.SSH_ORIGINAL_COMMAND : args[2] === '--command' ? args[3] : '';
  if (!/^[A-Za-z0-9+/]{1,90000}={0,2}$/.test(encoded || '')) throw new Error('Only bounded encoded photo commands are accepted');
  const input = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  const config = JSON.parse(await fs.readFile(args[1], 'utf8'));
  const service = await createPhotoProjection(config);
  const handlers = { project: ['operationId', 'runId', 'items'], projection: ['sha256'], exportCard: ['sha256', 'analysisId', 'card'],
    runs: [], page: ['runId', 'offset', 'limit'], occurrence: ['runId', 'requestId'] };
  if (!Object.hasOwn(handlers, input.op) || Object.keys(input).some(k => k !== 'op' && !handlers[input.op].includes(k)))
    throw new Error('Invalid photo processing operation');
  let data;
  if (['runs', 'page', 'occurrence'].includes(input.op)) {
    const library = await createPhoneLibrary(config);
    if (input.op === 'runs') data = await library.list();
    else if (input.op === 'page') data = await library.page(input);
    else {
      const entry = await library.occurrence(id(input.runId), id(input.requestId));
      if (!entry.receipt) throw Object.assign(new Error('A verified import receipt is required'), { code: 'BACKUP_REQUIRED' });
      const { sha256, size, verifiedAt, sourceReassociated } = entry.receipt;
      data = { source: entry.source, backup: { sha256, size, verifiedAt, sourceReassociated } };
    }
  } else data = input.op === 'projection' ? await service.existing(input.sha256) : await service[input.op](input);
  process.stdout.write(JSON.stringify({ ok: true, data }) + '\n');
}
main().catch(error => { process.stdout.write(JSON.stringify({ ok: false, error: { code: error.code || 'PHOTO_PROCESSING_FAILED', message: error.message } }) + '\n'); process.exitCode = 1; });
