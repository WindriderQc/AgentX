#!/usr/bin/env node
'use strict';

// Explicit synthetic native transport qualification. No WPD phone is opened.
// Uses the configured receiver and its isolated Media qualification root.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { runImport } = require('../import.cjs');
const { createRemote } = require('../transport.cjs');
const { hashFile } = require('../../../core/src/services/photos/importFiles');

async function main() {
  const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const fixtureRoot = path.join(config.cacheRoot, 'synthetic-source-' + crypto.randomUUID());
  await fs.mkdir(fixtureRoot, { recursive: true });
  const bytes = ['synthetic-photo-A', 'synthetic-photo-A', 'synthetic-photo-B'];
  for (let i = 0; i < bytes.length; i++) await fs.writeFile(path.join(fixtureRoot, i + '.jpg'), bytes[i], { flag: 'wx' });
  const snapshots = await Promise.all(bytes.map((_, i) => hashFile(path.join(fixtureRoot, i + '.jpg'))));
  const files = bytes.map((b, i) => ({ objectId: String(i), key: 'synthetic-'+i, name: 'photo.jpg', relativePath: 'DCIM/'+i+'/photo.jpg', size: Buffer.byteLength(b), modified: null }));
  let sourceReads = 0;
  const source = {
    devices: async () => [{ id: 'synthetic-device' }],
    inventory: async () => ({ complete: true, errors: [], objectsVisited: 3, files }),
    read: async (_, item, destination) => {
      sourceReads++;
      await fs.copyFile(path.join(fixtureRoot, item.objectId + '.jpg'), destination, require('node:fs').constants.COPYFILE_EXCL);
      return { ...await hashFile(destination), source: item };
    }
  };
  const original = createRemote(config);
  let loseResponse = true;
  const remote = async (input, payload) => {
    const result = await original(input, payload);
    if (input.action === 'receive' && loseResponse) { loseResponse = false; throw new Error('Synthetic lost acknowledgment after verified Media publication'); }
    return result;
  };
  const first = await runImport(config, { source, remote });
  assert.equal(first.state, 'incomplete');
  const resumed = await runImport(config, { source, remote, resume: first.runId });
  assert.equal(resumed.state, 'complete');
  assert.equal(resumed.counts.copied, 2); assert.equal(resumed.counts.duplicates, 1);
  const repeated = await runImport(config, { source, remote });
  assert.equal(repeated.counts.copied, 0); assert.equal(repeated.counts.duplicates, 3);
  const final = await Promise.all(bytes.map((_, i) => hashFile(path.join(fixtureRoot, i + '.jpg'))));
  assert.deepEqual(final, snapshots);
  const receipt = { schema: 'agentx.photo-import-native-smoke/v1', at: new Date().toISOString(),
    synthetic: true, actualPhoneTested: false, first, resumed, repeated, sourceReads, sourceFilesUnchanged: true };
  await fs.writeFile(path.join(config.cacheRoot, 'native-smoke-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
