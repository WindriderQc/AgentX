'use strict';

// Disposable test process only; production mutation has a separate operator CLI.
const fs = require('node:fs');
const mongoose = require('mongoose');
const { hash } = require('../../src/services/finance/financeRepairStorage');
const { createExecutor } = require('../../src/services/finance/financeRepairExecutor');
const [uri,root,archive,file,mode,stop,index,coreOrigin] = process.argv.slice(2);
const parsed = new URL(uri);
if (process.env.NODE_ENV !== 'test' || parsed.hostname !== '127.0.0.1' || !parsed.pathname.includes('test')) throw new Error('Disposable local test database required');
(async () => {
  await mongoose.connect(uri,{autoCreate:false,autoIndex:false});
  const bytes = fs.readFileSync(file);
  const receipt = await createExecutor({ checkpoint: async (name,detail) => {
    if (name === stop && (index === '-' || String(detail?.index) === index)) {
      process.send({ checkpoint:name,index:detail?.index });
      await new Promise(() => {});
    }
  } }).execute({bytes,confirmedDigest:hash(bytes),mode,actor:'synthetic-test',receiptRoot:root,archiveRoot:archive,coreOrigin});
  process.send({receipt});
  await mongoose.disconnect();
})().catch(async e => { process.send({error:e.code||e.message}); await mongoose.disconnect(); process.exitCode=1; });
