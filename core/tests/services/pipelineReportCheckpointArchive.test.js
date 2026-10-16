'use strict';
const crypto = require('crypto');
const Task = require('../../models/PipelineTask');
const Run = require('../../models/PipelineReportRun');
const File = require('../../models/PipelineTaskDeliverable');
const Runtime = require('../../models/RuntimeCoordination');
const Archive = require('../../models/PipelineReportCheckpointArchive');
const archives = require('../../src/services/pipelineReportCheckpointArchive');
const authority = require('../../src/services/pipelineReportAuthority');
const checkpoints = require('../../src/services/pipelineReportCheckpoint');
const files = require('../../src/services/pipelineTaskDeliverableService');
const { specHash } = require('../../src/services/pipelineManualReportClaim');
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
let control, key, task, body, nativeBytes;
beforeEach(async () => {
  await Promise.all([Task.deleteMany({}), Run.deleteMany({}), File.deleteMany({}), Runtime.deleteMany({}), Archive.deleteMany({})]);
  key = crypto.randomUUID(); nativeBytes = '# Original model checkpoint\n\nVerified claims and pending scope.\n';
  const outcome = { schema: 'agentx.pipeline-worker-outcome/v1', requestId: key, pipelineId: '0001', claimSeq: 2,
    source: 'worker_report', result: 'blocked', reason: 'model_call_limit', usage: { modelCalls: 128, workSeconds: 1000 } };
  task = await Task.create({ pipelineId: '0001', title: 'Checkpoint fixture', spec: 'Review the documentation.', service: 'agentx-coding',
    status: 'blocked', assignee: 'coding-team', transitionSeq: 3, feedback: [{ by: 'coding-team', workerOutcome: outcome }] });
  body = { expectedTransitionSeq: 3, sourceCommit: 'a'.repeat(40), reportName: 'review.md', path: '.review-work/review.md',
    originalSpecSha256: specHash(task), scopeEvidence: { receiptRef: 'original-worker-scope', sha256: digest('original scope proof') },
    by: 'fixture-operator', sha256: digest(nativeBytes), confirmation: 'ARCHIVE_MODEL_CHECKPOINT_WITH_NATIVE_TERMINATION_EVIDENCE',
    termination: { receiptRef: 'private-independent-native-proof', sha256: digest('native termination proof') },
    dataUrl: 'data:text/markdown;base64,' + Buffer.from('# Injected operator text must be ignored').toString('base64') };
  control = { launch: jest.fn(), status: jest.fn(async () => ({ busy: false, run: { requestId: key, pipelineId: '0001', phase: 'finished',
    progress: { phase: 'finished', coreRecorded: false, result: 'blocked', stopReason: 'model_call_limit', checkpoint: body.sourceCommit,
      usage: { modelCalls: 128, workSeconds: 1000, modelSeconds: 970, testSeconds: 0 } } } })),
  checkpoint: jest.fn(async () => ({ pipelineId: '0001', requestId: key, sourceCommit: body.sourceCommit, path: body.path,
    sha256: digest(nativeBytes), dataUrl: 'data:text/markdown;base64,' + Buffer.from(nativeBytes).toString('base64') })) };
  authority.configureControl(control);
});
afterEach(() => jest.restoreAllMocks());
test('native checkpoint archival keeps original model bytes, historical costs and operator provenance without inventing a report Run', async () => {
  const before = task.feedback.map(row => row.toObject());
  const archived = await archives.archive('0001', key, body);
  const downloaded = await files.download('0001', archived.deliverableId);
  expect(downloaded.data.toString()).toBe(nativeBytes);
  expect(downloaded.receipt).toMatchObject({ producer: { channel: 'report_archive', declared: 'fixture-operator' },
    reportOrigin: { contentAuthor: 'coding-team', depositChannel: 'operator_archive', archiveActor: 'fixture-operator' } });
  const stored = await Task.findById(task._id).lean();
  expect(stored.feedback).toEqual(before); expect(stored.status).toBe('blocked');
  expect(authority.history(stored, [])).toMatchObject({ executions: 1, modelCalls: 128, workSeconds: 1000, modelSeconds: 970, testSeconds: 0 });
  expect(await Run.countDocuments({})).toBe(0); expect(control.launch).not.toHaveBeenCalled();
  const restored = await checkpoints.read({ _id: crypto.randomUUID(), parentRequestId: key, parentSha256: body.sha256,
    pipelineId: '0001', taskId: String(task._id), specSha256: specHash(stored), sourceCommit: body.sourceCommit, claimSeq: 4 });
  expect(Buffer.from(restored.dataUrl.split(',')[1], 'base64').toString()).toBe(nativeBytes);
});
test('lost task attachment acknowledgement replays the same archive and never re-reads or replaces the native content', async () => {
  const original = Task.updateOne.bind(Task); let lost = false;
  jest.spyOn(Task, 'updateOne').mockImplementation(async (...args) => {
    const saved = await original(...args);
    if (args[1].$set?.reportHistoryReceipts && !lost) { lost = true; throw new Error('Synthetic archive attachment acknowledgement lost'); }
    return saved;
  });
  await expect(archives.archive('0001', key, body)).rejects.toThrow('acknowledgement lost');
  expect((await archives.archive('0001', key, body)).sha256).toBe(body.sha256);
  expect(await Archive.countDocuments({})).toBe(1); expect(await File.countDocuments({})).toBe(1);
  expect(control.checkpoint).toHaveBeenCalledTimes(1); expect(control.launch).not.toHaveBeenCalled();
});
test('a changed native checkpoint or mismatched archive identity refuses without modifying the old result', async () => {
  control.checkpoint.mockResolvedValue({ requestId: key, pipelineId: '0001', sourceCommit: body.sourceCommit, path: body.path, sha256: digest('altered') });
  await expect(archives.archive('0001', key, body)).rejects.toMatchObject({ code: 'REPORT_BYTES_UNVERIFIED' });
  expect(await File.countDocuments({})).toBe(0); expect(await Archive.countDocuments({})).toBe(0);
  expect((await Task.findById(task._id).lean()).feedback[0].workerOutcome.requestId).toBe(key);
});

test('archive requires explicit original scope proof and refuses to relabel an old result after a specification edit', async () => {
  await expect(archives.archive('0001', key, { ...body, scopeEvidence: null })).rejects.toMatchObject({ code: 'REPORT_ARCHIVE_INVALID' });
  await Task.updateOne({ _id: task._id }, { $set: { spec: 'A different assignment' } });
  await expect(archives.archive('0001', key, body)).rejects.toMatchObject({ code: 'REPORT_SCOPE_CHANGED' });
  expect(await File.countDocuments({})).toBe(0);
});
