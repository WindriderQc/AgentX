'use strict';

// Run once in the reviewed Core image, with the instance's external env, before
// normal deployment. Never start a second Core server to recover its owner.
const fs = require('node:fs');
const mongoose = require('mongoose');
const service = require('../src/services/pipelineCodingCapacityRecovery');

async function main(args = process.argv.slice(2)) {
  const [action, file] = args;
  if (!['prepare', 'recover-children', 'complete'].includes(action) || !file || args.length !== 2)
    throw new Error('Use: recover-coding-capacity.js prepare|recover-children|complete <private-intent.json>');
  if (fs.statSync(file).size > 16384) throw new Error('Recovery intent exceeds the bounded contract');
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = new URL(process.env.AGENTX_CORE_URL || 'http://127.0.0.1:3180');
  if (!process.env.MONGODB_URI) throw new Error('The Core instance database must be explicitly configured');
  const read = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Native owner or runtime read failed');
    return response.json();
  };
  const control = { status: async ({ requestId }) =>
    (await read(new URL(`/api/runtime-bridges/coding-dispatch/status?requestId=${encodeURIComponent(requestId)}`, base))).data };
  const readPs = async host => (await read(new URL('/api/ps', host))).models;
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const result = await service[action === 'recover-children' ? 'recoverChildren' : action](input.pipelineId, input.requestId, input, { control, readPs });
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(error => {
  process.stderr.write(JSON.stringify({ code: error.code || 'CODING_RECOVERY_FAILED', message: error.message }) + '\n');
  process.exitCode = 1;
});
module.exports = { main };
