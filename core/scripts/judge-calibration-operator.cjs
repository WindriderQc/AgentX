'use strict';

// Called only by the instance's closed maintenance action in a disposable Core
// control container. Does not start server.js, scheduling, inference or models.
const mongoose = require('mongoose');
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== '--operation' || args[2] !== '--actor' || args[4] !== '--input')
    throw new Error('Expected operation, actor and bounded encoded request');
  if (!['cancel', 'settle'].includes(args[1]) || !args[3] || args[3].length > 160 || args[5].length > 4096)
    throw new Error('Invalid operator arguments');
  if (!process.env.MONGODB_URI) throw new Error('Core database configuration is required');
  const input = JSON.parse(Buffer.from(args[5], 'base64').toString('utf8'));
  await mongoose.connect(process.env.MONGODB_URI, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5000 });
  try {
    const result = await require('../src/services/judgeCalibrationOperator').operate(args[1], input, args[3]);
    process.stdout.write(JSON.stringify({ schema: 'agentx.judge-calibration-operator/v1', operation: args[1], result }) + '\n');
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { main };
