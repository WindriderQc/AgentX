'use strict';
const crypto = require('node:crypto');
const Runs = require('../../../models/PhotoProcessingRun');
const Batches = require('../../../models/PhotoProcessingBatch');
const { id, hash } = require('./phoneLibrary');
const { fail } = require('./importFiles');
const { loadProcessingConfig } = require('./photoProcessingConfig');
const { createPhotoProcessingBridge } = require('./photoProcessingBridge');
const WC = { w: 1, j: true };
function operationId(value) {
  const bytes = crypto.createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
  const text = bytes.toString('hex'); return [text.slice(0, 8), text.slice(8, 12), text.slice(12, 16), text.slice(16, 20), text.slice(20)].join('-');
}
async function enrollRun(input, deps = {}) {
  const runId = id(input.runId), requestId = id(input.operationId), config = (deps.config || loadProcessingConfig)();
  if (!config) throw fail('PHOTO_PROCESSING_NOT_CONFIGURED', 'Configure the photo pipeline');
  await Runs.ensureProcessingIndexes();
  const prior = await Runs.findOne({ requestIds: requestId }).lean();
  if (prior && prior._id !== runId) throw fail('REQUEST_CONFLICT', 'This processing identity already selects another import');
  try { await Runs.updateOne({ _id: runId }, { $addToSet: { requestIds: requestId } }, { upsert: true, writeConcern: WC }); }
  catch (error) { if (error.code !== 11000) throw error;
    const saved = await Runs.findOne({ requestIds: requestId }).lean();
    if (saved?._id !== runId) throw fail('REQUEST_CONFLICT', 'This processing identity already selects another import');
  }
  return { operationId: requestId, runId, state: 'active' };
}
async function discover(deps = {}) {
  const config = (deps.config || loadProcessingConfig)();
  if (!config) return;
  const bridge = deps.bridge || createPhotoProcessingBridge({ config: deps.config || loadProcessingConfig });
  if (config.autoProcess === true) {
    const result = await bridge.call({ op: 'runs' });
    for (const run of result.runs) await enrollRun({ runId: run.runId, operationId: operationId('photo-run:'+run.runId) }, deps);
  }
  // A bounded ledger walk discovers newly received originals without any USB
  // read. Pending receipts are revisited on the next pass; partial inventories
  // never imply a complete phone backup.
  for (const run of await Runs.find({ state: 'active' }).sort({ lastObservedAt: 1 }).limit(5).lean()) {
    try {
      let cursor = run.cursor;
      for (let pages = 0; pages < 4; pages++) {
        const page = await bridge.call({ op: 'page', runId: run._id, offset: cursor, limit: 100 });
        const known = await Batches.find({ runId: run._id, items: { $in: page.items.map(x => x.requestId) } }).lean();
        const claimed = new Set(known.flatMap(x => x.items));
        const available = page.items.filter(x => x.backup && !claimed.has(x.requestId)).map(x => x.requestId).slice(0, 24);
        if (available.length) {
          const items = available.sort();
          await require('./photoProcessingQueue').enqueue({ operationId: operationId(hash([run._id, items])), runId: run._id, items }, deps);
          await Runs.updateOne({ _id: run._id }, { $set: { lastObservedAt: new Date(), total: page.total }, $unset: { error: 1 } });
          break;
        }
        const next = cursor + page.items.length >= page.total || !page.items.length ? 0 : cursor + page.items.length;
        await Runs.updateOne({ _id: run._id, cursor }, { $set: { cursor: next, total: page.total, lastObservedAt: new Date() }, $unset: { error: 1 } });
        cursor = next;
        if (cursor === 0) break;
      }
    } catch (error) { await Runs.updateOne({ _id: run._id }, { $set: { error: error.code || 'PHOTO_DISCOVERY_UNAVAILABLE', lastObservedAt: new Date() } }); }
  }
}
module.exports = { enrollRun, discover, operationId };
