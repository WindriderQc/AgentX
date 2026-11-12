#!/usr/bin/env node
'use strict';
// Run inside Core with its existing environment. The plan contains only the
// stable setup identity and managed names, never a key or file path.
const mongoose = require('mongoose');
async function main() {
  if (!process.env.MONGODB_URI || !process.env.IMMICH_API_KEY_FILE || process.argv.length !== 3)
    throw Error('Provision inside the configured Core runtime with one base64 JSON plan');
  const encoded = process.argv[2];
  if (!/^[A-Za-z0-9+/]{1,16000}={0,2}$/.test(encoded)) throw Error('Expected a bounded encoded setup plan');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
  try {
    const result = await require('../src/services/photos/photoProcessingSetup').provision(JSON.parse(Buffer.from(encoded, 'base64')));
    process.stdout.write(JSON.stringify({ ok: true, data: result })+'\n');
  } finally { await mongoose.disconnect(); }
}
main().catch(error => { process.stderr.write(JSON.stringify({ code: error.code || 'PHOTO_SETUP_FAILED', message: error.message })+'\n'); process.exitCode = 1; });
