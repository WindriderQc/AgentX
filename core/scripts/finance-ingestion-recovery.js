'use strict';

// Native operator only. No extraction, model call, inbox deposit or gate reset.
const mongoose = require('mongoose');
const access = require('../src/services/finance/financeAccess');
const journal = require('../src/services/finance/financeIngestionJournal');

function argumentsOf(values) {
  const [command, ...rest] = values;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--request', '--confirmed-digest', '--source', '--actor', '--core-origin'].includes(rest[i]) || !rest[i + 1]) throw new Error('Invalid recovery option');
    options[rest[i].slice(2)] = rest[i + 1];
  }
  if (!['status', 'resume'].includes(command)) throw new Error('Choose status or resume');
  if (command === 'status' && rest.length) throw new Error('status takes no recovery options');
  if (command === 'resume' && ['request', 'confirmed-digest', 'source', 'actor', 'core-origin'].some(key => !options[key])) throw new Error('resume requires --request, --confirmed-digest, --source, --actor and --core-origin');
  return { command, options };
}

async function main(values = process.argv.slice(2)) {
  const { command, options } = argumentsOf(values);
  if (!process.env.MONGODB_URI) throw new Error('Use the native Core database configuration');
  try {
    await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
    if (command === 'status') {
      const gate = await access.state();
      const pending = gate.ingestion ? await mongoose.connection.db.collection('finance_ingestions').findOne(
        { _id: gate.ingestion.requestKey }, { projection: { digest: 1, phase: 1, received: 1, createdAt: 1, 'candidate.base.fileSha256': 1 } }) : null;
      return { held: Boolean(gate.repair || gate.ingestion), readers: gate.readers.length, ingestion: pending };
    }
    return await journal.resume({ requestKey: options.request, confirmedDigest: options['confirmed-digest'],
      sourcePath: options.source, actor: options.actor, coreOrigin: options['core-origin'] });
  } finally { await mongoose.disconnect(); }
}

if (require.main === module) main().then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(JSON.stringify({ code: error.code || 'FINANCE_INGESTION_RECOVERY_FAILED', message: error.message })); process.exitCode = 1; });
module.exports = { argumentsOf, main };
