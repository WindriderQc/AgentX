#!/usr/bin/env node
'use strict';
// Private operator export only. No HTTP route, photo writes, scans or inference.
const fs = require('node:fs/promises');
const MAX_PLAN_BYTES = 16384;
async function main({ argv = process.argv.slice(2), env = process.env, readFile = fs.readFile,
  connect, disconnect, registry, write = text => process.stdout.write(text) } = {}) {
  if (argv.length !== 1) throw Error('Supply one private JSON selection file containing sha256s');
  const bytes = await readFile(argv[0]);
  if (bytes.length > MAX_PLAN_BYTES) throw Error('Selection file exceeds its bound');
  const plan = JSON.parse(bytes.toString('utf8'));
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || Object.keys(plan).some(k => k !== 'sha256s')
    || !Array.isArray(plan.sha256s) || !plan.sha256s.length || plan.sha256s.length > 100
    || plan.sha256s.some(s => typeof s !== 'string' || !/^[a-f0-9]{64}$/.test(s))
    || new Set(plan.sha256s).size !== plan.sha256s.length) throw Error('Supply one to one hundred unique content SHA-256 identities');
  if (!env.MONGODB_URI) throw Error('Configure the operator Mongo connection');
  let connected = false;
  const mongoose = (!connect || !disconnect) ? require('mongoose') : null;
  try {
    await (connect || mongoose.connect.bind(mongoose))(env.MONGODB_URI,
      { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
    connected = true;
    const service = registry || require('../src/services/photos/photoPortableRegistry').createPhotoPortableRegistry();
    const result = await service.exportSelection({ sha256s: plan.sha256s, audience: 'owner' });
    write(JSON.stringify(result) + '\n');
    return result;
  } finally {
    if (connected) await (disconnect || mongoose.disconnect.bind(mongoose))();
  }
}
if (require.main === module) main().catch(() => {
  // Avoid printing stored content, credentials or DB error strings to logs.
  console.error('Private photo registry export failed; no export was confirmed. Verify the selection and connection.');
  process.exitCode = 1;
});
module.exports = { main };
