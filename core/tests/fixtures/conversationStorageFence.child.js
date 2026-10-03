'use strict';

// Independent writer against the parent's disposable Mongo. Only the timing
// boundary is controlled: every content mutation uses the real storage code.
const mongoose = require('mongoose');
const exchanges = require('../../src/services/conversations/exchangeReceipts');
const transcripts = require('../../src/services/conversations/transcriptStore');
const { withOwnerWrite } = require('../../src/services/conversations/writeFence');
const input = JSON.parse(process.env.CONVERSATION_FENCE_INPUT);
const send = value => new Promise(resolve => process.send(value, resolve));
const resume = () => new Promise(resolve => process.once('message', resolve));

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  if (input.pauseCollection) {
    const collection = mongoose.connection.collection(input.pauseCollection);
    const original = collection[input.pauseMethod].bind(collection);
    let paused = false;
    collection[input.pauseMethod] = async (...args) => {
      if (!paused) {
        paused = true;
        const resumed = resume();
        await send({ event: 'paused' });
        await resumed;
      }
      return original(...args);
    };
  }
  let result;
  if (input.action === 'append') result = await exchanges.append(input.receipt, 0, Buffer.from('Late synthetic response'));
  else if (input.action === 'accept') result = await exchanges.accept(input.scope, { body: { message: 'Synthetic input' } }, input.key);
  else if (input.action === 'transcript') result = await transcripts.writeTranscript(input.owner,
    [{ role: 'assistant', content: 'Synthetic transcript' }]);
  else if (input.action === 'hold') result = await withOwnerWrite(input.owner, async () => {
    await send({ event: 'paused' });
    await new Promise(() => {});
  });
  else throw new Error('Unknown fixture action');
  await send({ event: 'result', result });
})().catch(async error => {
  await send({ event: 'failure', code: error.code, message: error.message });
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
