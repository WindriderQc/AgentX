#!/usr/bin/env node
'use strict';

// Native operator entrance only. No tool grant or HTTP mutation is added.
const fs = require('node:fs/promises');
const mongoose = require('mongoose');
const { createExecutor } = require('../src/services/finance/financeRepairExecutor');

async function main() {
  const [mode,...args] = process.argv.slice(2);
  if (!['apply','resume','rollback'].includes(mode) || args.length % 2) throw new Error('Use apply|resume|rollback --manifest FILE --confirm SHA256 --actor NAME');
  const options = {};
  for (let i=0;i<args.length;i+=2) {
    if (!['--manifest','--confirm','--actor'].includes(args[i]) || options[args[i]]) throw new Error('Unsupported or duplicate Finance repair option');
    options[args[i]] = args[i+1];
  }
  if (!options['--manifest'] || !options['--confirm'] || !options['--actor'] || !process.env.MONGODB_URI) throw new Error('Explicit manifest, digest, actor and native Mongo environment are required');
  await mongoose.connect(process.env.MONGODB_URI,{ autoCreate: false, autoIndex: false });
  try {
    const receipt = await createExecutor().execute({ mode, bytes: await fs.readFile(options['--manifest']),
      confirmedDigest: options['--confirm'], actor: options['--actor'],
      receiptRoot: process.env.FINANCE_REPAIR_ROOT, archiveRoot: process.env.FINANCE_ARCHIVE_PATH,
      coreOrigin: process.env.AGENTX_CORE_URL });
    process.stdout.write(JSON.stringify(receipt)+'\n');
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(e => {
  process.stderr.write(JSON.stringify({ status: 'refused_or_held', code: e.code || 'FINANCE_REPAIR_FAILED', message: e.message })+'\n');
  process.exitCode = 1;
});

module.exports = { main };
