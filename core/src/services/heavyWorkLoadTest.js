'use strict';

const PerformanceLoadTest = require('../../models/PerformanceLoadTest');
const parser = require('./artilleryParser');
const { fail, text, instant, digest } = require('./heavyWorkQueueContract');

// A report is part of the existing executor's terminal receipt. No launch,
// admission or native runtime release is owned by this projection.
async function prepare(id, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['name', 'scenario', 'timestamp', 'raw_report'].includes(key))) {
    throw fail('loadTest needs name, scenario, timestamp and raw_report');
  }
  const report = {
    name: text(input.name, 'loadTest.name', 200),
    scenario: text(input.scenario, 'loadTest.scenario', 120),
    timestamp: instant(input.timestamp, 'loadTest.timestamp'),
    raw_report: input.raw_report
  };
  const validation = parser.validateReport(report.raw_report);
  if (!validation.valid) throw fail('Invalid Artillery report', 400, 'LOAD_TEST_INVALID', validation.errors);
  let document;
  try {
    document = new PerformanceLoadTest({ ...report, ...parser.parseArtilleryReport(report.raw_report), queueJobId: id });
    await document.validate();
  } catch {
    throw fail('Invalid Artillery report metrics', 400, 'LOAD_TEST_INVALID');
  }
  return { document, hash: digest(report) };
}

function sameReceipt(job, body, actor, hash) {
  const receipt = job.releaseReceipt;
  return ['completed', 'failed', 'cancelled'].includes(job.state)
    && receipt?.authority === 'operator-attestation'
    && job.state === body.state && job.dispatchId === body.dispatchId
    && receipt.receiptRef === body.receiptRef && receipt.receiptSha256 === body.receiptSha256
    && receipt.confirmation === body.confirmation && receipt.actor === actor
    && receipt.loadTestHash === hash;
}

async function store(document) {
  // The unique sparse job index protects both concurrent upserts and restarts.
  // Manual imports carry no job identity and retain their existing behavior.
  await PerformanceLoadTest.collection.createIndex({ queueJobId: 1 }, { unique: true, sparse: true });
  const data = document.toObject();
  delete data._id;
  data.createdAt = data.imported_at;
  data.updatedAt = data.imported_at;
  try {
    return await PerformanceLoadTest.findOneAndUpdate({ queueJobId: data.queueJobId },
      { $setOnInsert: data }, { upsert: true, new: true, timestamps: false, writeConcern: { w: 1, j: true } });
  } catch (error) {
    if (error.code !== 11000) throw error;
    const existing = await PerformanceLoadTest.findOne({ queueJobId: data.queueJobId });
    if (!existing) throw error;
    return existing;
  }
}

async function finish(id, body, actor, { get, complete }) {
  if (body?.loadTest === undefined) return complete(id, body, actor);
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) throw fail('expectedRevision required');
  let job = await get(id);
  if (job.executor?.mode !== 'operator' || !['diagnostic', 'other'].includes(job.kind)) {
    throw fail('Load tests require the existing operator executor', 409);
  }
  const { document, hash } = await prepare(id, body.loadTest);
  if (!sameReceipt(job, body, actor, hash)) {
    try {
      // Terminal state, release evidence and report hash commit together first.
      job = await complete(id, body, actor, hash);
    } catch (error) {
      // Another delivery may have won the terminal CAS. Reconcile that exact
      // receipt, including after archive, without a second queue transition.
      job = await get(id);
      if (!sameReceipt(job, body, actor, hash)) throw error;
    }
  }
  // A failed insert leaves the durable terminal receipt intact. Retrying the
  // same receipt repairs only this projection and never re-executes the job.
  const saved = await store(document);
  return { ...job, loadTest: { id: String(saved._id), timestamp: saved.timestamp, queueJobId: id } };
}

module.exports = { finish };
