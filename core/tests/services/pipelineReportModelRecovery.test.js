'use strict';
const crypto = require('crypto');
const Task = require('../../models/PipelineTask');
const Run = require('../../models/PipelineReportRun');
const Runtime = require('../../models/RuntimeCoordination');
const Binding = require('../../models/PipelineReportAdmission');
const File = require('../../models/PipelineTaskDeliverable');
const files = require('../../src/services/pipelineTaskDeliverableService');
const recovery = require('../../src/services/pipelineReportModelRecovery');
const reports = require('../../src/services/pipelineReportService');
const { specHash } = require('../../src/services/pipelineManualReportClaim');
const uuid = () => crypto.randomUUID();
let task, run, row, native, receipt, identity, body, control;
beforeEach(async () => {
  await Promise.all([Task.deleteMany({}), Run.deleteMany({}), Runtime.deleteMany({}), Binding.deleteMany({}), File.deleteMany({})]);
  task = await Task.create({ pipelineId: '0001', service: 'agentx-coding', title: 'Synthetic report', spec: 'Review frozen source.',
    status: 'in_progress', assignee: 'coding-team', transitionSeq: 2 });
  await Task.updateOne({ _id: task._id }, { $set: { transitions: [{ kind: 'claimed', seq: 2 }] } });
  row = { callId: uuid(), prepareId: uuid(), state: 'unknown', startedAt: new Date(Date.now() - 10000).toISOString(),
    finishedAt: new Date(Date.now() - 5000).toISOString() };
  run = await Run.create({ _id: uuid(), pipelineId: '0001', taskId: String(task._id), claimSeq: 2, specSha256: specHash(task),
    sourceCommit: 'a'.repeat(40), reportName: 'review.md', model: 'synthetic-model', host: 'http://model.invalid:11434',
    deadlineAt: new Date(Date.now() - 1000), modelReceipts: [row], pendingInferences: [row.callId] });
  native = { admissionId: uuid(), generation: uuid(), principal: 'core-trusted-runtime' };
  identity = { requestId: run._id, pipelineId: '0001', callId: row.callId, prepareId: row.prepareId };
  receipt = { contract: 'agentx.caller-abort-recovery/v1', released: true, ...native, host: run.host, model: run.model,
    acquiredAt: row.startedAt, unknownAt: row.finishedAt, unknownOrigin: 'caller-abort', releasedAt: new Date(Date.now() - 4000).toISOString() };
  await Runtime.create({ _id: 'runtime', releaseReceipts: [receipt] });
  control = { status: jest.fn(async () => ({ busy: false, run: { requestId: run._id, pipelineId: '0001', phase: 'unknown',
    progress: { checkpoint: run.sourceCommit } } })), launch: jest.fn() };
  recovery.configureControl(control);
  body = { callId: row.callId, prepareId: row.prepareId, expectedReceiptSha256: recovery.digest(row), claimSeq: 2,
    specSha256: run.specSha256, sourceCommit: run.sourceCommit, nativeAdmission: { admissionId: native.admissionId, generation: native.generation },
    by: 'synthetic-operator', confirmation: 'MAP_ORIGINAL_REPORT_CALL_TO_RELEASED_NATIVE_ADMISSION',
    evidence: { receiptRef: 'private-independent-mapping-proof', sha256: 'e'.repeat(64) } };
});
afterEach(() => jest.restoreAllMocks());
test('canonical receipts distinguish BSON dates and retain ISO millisecond identity', () => {
  const first = new Date('2026-10-14T12:00:00.123Z'), second = new Date('2026-10-15T12:00:00.123Z');
  expect(recovery.digest({ releasedAt: first })).not.toBe(recovery.digest({ releasedAt: second }));
  expect(recovery.digest({ releasedAt: first })).toBe(recovery.digest({ releasedAt: first.toISOString() }));
});
async function bind(proof = native) {
  await Run.updateOne({ _id: run._id }, { $set: { 'modelReceipts.0.state': 'pending' } });
  await recovery.bind(identity, proof);
  await Run.updateOne({ _id: run._id }, { $set: { 'modelReceipts.0.state': 'unknown' } });
}
test('bound cancellation adopts the exact native release, preserving the original unknown and duration', async () => {
  await bind(); const before = await Runtime.findById('runtime').select('+releaseReceipts').lean();
  await recovery.reconcile(await Run.findById(run._id).lean());
  const value = await Run.findById(run._id).lean(), call = value.modelReceipts[0];
  expect(value.pendingInferences).toEqual([]); expect(reports.termination(value)).toBe(true);
  expect(call).toMatchObject({ state: 'completed', startedAt: row.startedAt, finishedAt: row.finishedAt,
    settlement: { terminationOnly: true, recovered: true }, terminationRecovery: {
      originalUnknownReceipt: row, terminationAt: receipt.releasedAt, nativeReceipts: [receipt], terminationOnly: true } });
  expect(await Runtime.findById('runtime').select('+releaseReceipts').lean()).toEqual(before);
  expect((await Binding.findOne().lean()).releaseReceipt).toEqual(receipt);
  expect(control.launch).not.toHaveBeenCalled();
});
test('all bound attempts must be released and copied before settlement; journal eviction does not lose proof', async () => {
  await bind(); const second = { ...native, admissionId: uuid(), generation: uuid() }; await bind(second);
  await recovery.reconcile(await Run.findById(run._id).lean());
  expect((await Run.findById(run._id).lean()).modelReceipts[0].state).toBe('unknown');
  await Runtime.updateOne({ _id: 'runtime' }, { $set: { releaseReceipts: [{ ...receipt, ...second }] } });
  await recovery.reconcile(await Run.findById(run._id).lean());
  const value = await Run.findById(run._id).lean();
  expect(value.modelReceipts[0].terminationRecovery.nativeReceipts).toHaveLength(2);
  expect(value.pendingInferences).toEqual([]);
});
test('the observer preserves a pending retry release before journal eviction without settling the call', async () => {
  await Run.updateOne({ _id: run._id }, { $set: { 'modelReceipts.0.state': 'pending' } });
  await recovery.bind(identity, native); await recovery.observe();
  expect((await Binding.findOne().lean()).releaseReceipt).toEqual(receipt);
  expect((await Run.findById(run._id).lean()).modelReceipts[0].state).toBe('pending');
  const second = { ...native, admissionId: uuid(), generation: uuid() };
  await Runtime.updateOne({ _id: 'runtime' }, { $set: { releaseReceipts: [] } });
  await recovery.bind(identity, second);
  await Run.updateOne({ _id: run._id }, { $set: { 'modelReceipts.0.state': 'unknown' } });
  await recovery.observe();
  expect((await Run.findById(run._id).lean()).modelReceipts[0].state).toBe('unknown');
  await Runtime.updateOne({ _id: 'runtime' }, { $set: { releaseReceipts: [{ ...receipt, ...second }] } });
  await recovery.observe();
  expect((await Run.findById(run._id).lean()).modelReceipts[0].terminationRecovery.nativeReceipts).toHaveLength(2);
});
test('termination uses chronological BSON dates across attempts and preserves original call timestamps', async () => {
  await bind();
  const bson = { ...receipt, acquiredAt: new Date('2026-10-14T11:00:00.123Z'),
    unknownAt: new Date('2026-10-14T11:59:00.456Z'), releasedAt: new Date('2026-10-14T12:00:00.789Z') };
  await Runtime.updateOne({ _id: 'runtime' }, { $set: { releaseReceipts: [bson] } });
  const second = { ...native, admissionId: uuid(), generation: uuid() }; await bind(second);
  await recovery.reconcile(await Run.findById(run._id).lean());
  const later = { ...bson, ...second, acquiredAt: '2026-10-15T11:00:00.123Z',
    unknownAt: '2026-10-15T11:59:00.456Z', releasedAt: '2026-10-15T12:00:00.789Z' };
  await Runtime.updateOne({ _id: 'runtime' }, { $set: { releaseReceipts: [later] } });
  await recovery.reconcile(await Run.findById(run._id).lean());
  expect((await Run.findById(run._id).lean()).modelReceipts[0]).toMatchObject({ startedAt: row.startedAt,
    finishedAt: row.finishedAt, terminationRecovery: { terminationAt: later.releasedAt } });
});
test.each(['generation', 'principal', 'host', 'model'])('a native release with a different %s never clears UNKNOWN', async field => {
  await bind(); await Runtime.updateOne({ _id: 'runtime' }, { $set: { releaseReceipts: [{ ...receipt, [field]: 'different' }] } });
  await recovery.reconcile(await Run.findById(run._id).lean());
  expect((await Run.findById(run._id).lean()).modelReceipts[0]).toEqual(row);
});
test('a still-held native admission and an unbound legacy call remain fenced', async () => {
  await recovery.reconcile(await Run.findById(run._id).lean());
  expect((await Run.findById(run._id).lean()).modelReceipts[0]).toEqual(row);
  await bind(); await Runtime.updateOne({ _id: 'runtime' }, { $set: { inferences: [{ ...native, host: run.host, model: run.model, state: 'UNKNOWN' }] } });
  await recovery.reconcile(await Run.findById(run._id).lean());
  expect((await Run.findById(run._id).lean()).pendingInferences).toEqual([row.callId]);
});
test('operator legacy mapping is explicit, idempotent, and leaves the original UNKNOWN in its durable audit', async () => {
  expect(await recovery.mapLegacy('0001', run._id, body)).toMatchObject({ recovered: true, terminationOnly: true });
  expect(await recovery.mapLegacy('0001', run._id, body)).toMatchObject({ recovered: true, idempotent: true });
  await expect(recovery.mapLegacy('0001', run._id, { ...body, by: 'different-operator' })).rejects.toMatchObject({ code: 'REPORT_NATIVE_TERMINATION_UNVERIFIED' });
  const stored = await Run.findById(run._id).lean();
  expect(stored.modelReceipts[0].terminationRecovery).toMatchObject({ originalUnknownReceipt: row,
    operatorMapping: { authority: 'operator-attestation', evidence: body.evidence } });
  expect(await Binding.countDocuments()).toBe(1);
});
test.each(['expectedReceiptSha256', 'claimSeq', 'specSha256', 'sourceCommit', 'prepareId', 'confirmation'])('legacy mapping rejects changed %s without binding an admission', async field => {
  await expect(recovery.mapLegacy('0001', run._id, { ...body, [field]: 'changed' })).rejects.toBeTruthy();
  expect(await Binding.countDocuments()).toBe(0);
});
test('legacy mapping rejects contradictory native timing before persisting a binding', async () => {
  await Runtime.updateOne({ _id: 'runtime' }, { $set: { releaseReceipts: [{ ...receipt, acquiredAt: new Date(Date.now() - 60000).toISOString() }] } });
  await expect(recovery.mapLegacy('0001', run._id, body)).rejects.toMatchObject({ code: 'REPORT_NATIVE_TERMINATION_UNVERIFIED' });
  expect(await Binding.countDocuments()).toBe(0);
});
test.each(['startedAt', 'finishedAt', 'unknownAt', 'missingUnknown', 'unknownBeforeAdmission', 'unknownAfterRelease', 'futureRelease', 'oldCompletion'])('legacy mapping rejects invalid or contradictory %s before binding', async field => {
  const modified = { ...receipt };
  if (['startedAt', 'finishedAt'].includes(field)) {
    row[field] = 'invalid'; body.expectedReceiptSha256 = recovery.digest(row);
    await Run.updateOne({ _id: run._id }, { $set: { modelReceipts: [row] } });
  } else if (field === 'unknownAt') modified.unknownAt = 'invalid';
  else if (field === 'missingUnknown') delete modified.unknownAt;
  else if (field === 'unknownBeforeAdmission') modified.unknownAt = new Date(Date.parse(row.startedAt) - 1);
  else if (field === 'unknownAfterRelease') modified.unknownAt = new Date(Date.parse(receipt.releasedAt) + 1);
  else if (field === 'futureRelease') modified.releasedAt = new Date(Date.now() + 60000);
  else {
    row.startedAt = new Date(Date.parse(row.startedAt) - 20000).toISOString();
    body.expectedReceiptSha256 = recovery.digest(row);
    await Run.updateOne({ _id: run._id }, { $set: { modelReceipts: [row] } });
    modified.acquiredAt = row.startedAt; modified.contract = 'agentx.runtime-inference-completion/v1';
    modified.releasedAt = new Date(Date.parse(row.finishedAt) - 5001);
  }
  await Runtime.updateOne({ _id: 'runtime' }, { $set: { releaseReceipts: [modified] } });
  await expect(recovery.mapLegacy('0001', run._id, body)).rejects.toMatchObject({ code: 'REPORT_NATIVE_TERMINATION_UNVERIFIED' });
  expect(await Binding.countDocuments()).toBe(0);
});
test('legacy mapping accepts exact BSON owner dates and completion near the original finish', async () => {
  const completion = { ...receipt, contract: 'agentx.runtime-inference-completion/v1',
    acquiredAt: new Date(receipt.acquiredAt), releasedAt: new Date(row.finishedAt) };
  delete completion.unknownAt;
  await Runtime.updateOne({ _id: 'runtime' }, { $set: { releaseReceipts: [completion] } });
  await expect(recovery.mapLegacy('0001', run._id, body)).resolves.toMatchObject({ recovered: true });
  expect((await Run.findById(run._id).lean()).modelReceipts[0].finishedAt).toBe(row.finishedAt);
});
test('changed task scope or active native worker refuses legacy operator mapping', async () => {
  await Task.updateOne({ _id: task._id }, { $set: { spec: 'Different scope' } });
  await expect(recovery.mapLegacy('0001', run._id, body)).rejects.toBeTruthy();
  await Task.updateOne({ _id: task._id }, { $set: { spec: task.spec } }); control.status.mockResolvedValue({ busy: true });
  await expect(recovery.mapLegacy('0001', run._id, body)).rejects.toBeTruthy();
  expect(await Binding.countDocuments()).toBe(0);
});
test('native admission identity cannot be reused by another report call', async () => {
  await recovery.mapLegacy('0001', run._id, body);
  const other = { ...row, callId: uuid(), prepareId: uuid(), state: 'pending' };
  await Run.updateOne({ _id: run._id }, { $push: { modelReceipts: other } });
  await expect(recovery.bind({ ...identity, callId: other.callId, prepareId: other.prepareId }, native)).rejects.toBeTruthy();
  expect(await Binding.countDocuments()).toBe(1);
});
test('a lost recovery acknowledgement replays the exact mapping without another model call', async () => {
  const update = Run.updateOne.bind(Run); let lost = false;
  jest.spyOn(Run, 'updateOne').mockImplementation(async (...args) => {
    const result = await update(...args);
    if (args[1].$set?.['modelReceipts.$[call].terminationRecovery'] && !lost) { lost = true; throw new Error('Synthetic lost recovery acknowledgement'); }
    return result;
  });
  await expect(recovery.mapLegacy('0001', run._id, body)).rejects.toThrow('lost recovery acknowledgement');
  expect(await recovery.mapLegacy('0001', run._id, body)).toMatchObject({ recovered: true, idempotent: true });
  expect((await Run.findById(run._id).lean()).modelReceipts).toHaveLength(1);
});
test('an explicit operator task archive preserves a legacy native receipt after recent-journal eviction', async () => {
  const data = Buffer.from(JSON.stringify({ nativeReceipt: receipt }));
  const { receipt: archived } = await files.register('0001', { by: 'synthetic-operator', name: 'native-release.json',
    dataUrl: 'data:application/json;base64,' + data.toString('base64'), sha256: crypto.createHash('sha256').update(data).digest('hex') });
  body.evidence = { deliverableId: archived.id, receiptRef: archived.ref, sha256: archived.sha256 };
  await Runtime.updateOne({ _id: 'runtime' }, { $set: { releaseReceipts: [] } });
  await recovery.mapLegacy('0001', run._id, body);
  const stored = await Run.findById(run._id).lean();
  expect(stored.modelReceipts[0].terminationRecovery.operatorMapping.nativeReceiptSource).toBe('operator-task-archive');
  expect(stored.modelReceipts[0].finishedAt).toBe(row.finishedAt);
});
test('the existing Core observer captures bound recovery without touching an unrelated unbound UNKNOWN', async () => {
  await bind();
  const other = { ...run.toObject(), _id: uuid(), pipelineId: '0002', modelReceipts: [{ ...row, callId: uuid(), prepareId: uuid() }] };
  await Run.create(other); await recovery.observe();
  expect((await Run.findById(run._id).lean()).pendingInferences).toEqual([]);
  expect((await Run.findById(other._id).lean()).modelReceipts[0].state).toBe('unknown');
});
test('a legacy binding acknowledgement lost before Run settlement survives native journal rotation', async () => {
  const create = Binding.create.bind(Binding); let lost = false;
  jest.spyOn(Binding, 'create').mockImplementation(async (...args) => {
    const saved = await create(...args); if (!lost) { lost = true; throw new Error('Lost binding acknowledgement'); } return saved;
  });
  await expect(recovery.mapLegacy('0001', run._id, body)).rejects.toThrow('Lost binding acknowledgement');
  await Runtime.updateOne({ _id: 'runtime' }, { $set: { releaseReceipts: [] } });
  expect(await recovery.mapLegacy('0001', run._id, body)).toMatchObject({ recovered: true, idempotent: true });
  expect((await Run.findById(run._id).lean()).modelReceipts[0].terminationRecovery.originalUnknownReceipt).toEqual(row);
});
