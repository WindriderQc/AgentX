#!/usr/bin/env node
'use strict';
// A metadata-only native owner entrance. This reviewed CLI and its adjacent
// service can be staged outside a running installation; --core-root supplies
// its existing models and DB connection. No deployment/restart is required.
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { readFile } = require('node:fs/promises');
async function main() {
  const [coreRoot, serviceFile, intentFile] = process.argv.slice(2);
  if (!coreRoot || !serviceFile || !intentFile || process.argv.length !== 5) throw new Error('Usage: receive-report-cloud-refusal.cjs CORE_ROOT REVIEWED_SERVICE INTENT_JSON');
  const load = createRequire(resolve(coreRoot, 'package.json'));
  const mongoose = load('mongoose');
  const intent = JSON.parse(await readFile(intentFile, 'utf8'));
  const origin = new URL(process.env.CORE_PUBLIC_URL);
  const control = { status: async ({ requestId }) => {
    const response = await fetch(new URL(`/api/runtime-bridges/coding-dispatch/status?requestId=${encodeURIComponent(requestId)}`, origin),
      { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) throw new Error('Native status unavailable');
    const result = await response.json(); return result.data;
  } };
  if (!process.env.MONGODB_URI) throw new Error('Installed Core DB configuration is required');
  await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 1, serverSelectionTimeoutMS: 5000 });
  try {
    const receiver = require(resolve(serviceFile)).createRecovery({ coreRoot, control });
    console.log(JSON.stringify(await receiver.receive(intent.pipelineId, intent.requestId, intent.body)));
  } finally { await mongoose.disconnect(); }
}
main().catch(error => { console.error(JSON.stringify({ code: error.code || 'REPORT_CLOUD_REFUSAL_FAILED' })); process.exitCode = 1; });
