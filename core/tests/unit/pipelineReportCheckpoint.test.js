'use strict';
jest.mock('../../models/PipelineReportRun', () => ({ findById: jest.fn() }));
jest.mock('../../src/services/pipelineTaskDeliverableService', () => ({ download: jest.fn() }));
jest.mock('../../src/services/pipelineReportCheckpointArchive', () => ({ parent: jest.fn(async () => null) }));
jest.mock('../../src/services/pipelineReportPreflight', () => ({ parent: jest.fn(async () => null) }));
const Run = require('../../models/PipelineReportRun');
const files = require('../../src/services/pipelineTaskDeliverableService');
const checkpoints = require('../../src/services/pipelineReportCheckpoint');
const HASH = 'c'.repeat(64);
let parents, selected;
beforeEach(() => {
  const base = { pipelineId: '0001', taskId: 'synthetic-task', specSha256: 'b'.repeat(64), sourceCommit: 'a'.repeat(40),
    state: 'blocked', pendingInferences: [], modelReceipts: [{ state: 'completed' }] };
  parents = new Map([
    ['original', { ...base, _id: 'original', claimSeq: 2, parentRequestId: null,
      result: { kind: 'blocked', partial: { deliverableId: 'saved-file', sha256: HASH } } }],
    ['refused', { ...base, _id: 'refused', claimSeq: 5, preflight: true,
      parentRequestId: 'original', parentSha256: null,
      result: { kind: 'blocked', preflight: true, refusalCode: 'REPORT_CHECKPOINT_CONFLICT' } }],
  ]);
  selected = { ...base, _id: 'new-explicit-request', claimSeq: 8, parentRequestId: 'refused', parentSha256: HASH };
  Run.findById.mockImplementation(id => ({ lean: async () => parents.get(id) || null }));
  files.download.mockResolvedValue({ receipt: { sha256: HASH }, data: Buffer.from('# Preserved partial\n') });
});
afterEach(() => jest.clearAllMocks());

test('an explicit ancestral digest recovers through a refused continuation without changing prior intent', async () => {
  const before = JSON.stringify([...parents]);
  const result = await checkpoints.load(selected);
  expect(result.parent._id).toBe('refused');
  expect(result.contentRequestId).toBe('original');
  expect(result.inherited).toBe(true);
  expect(result.receipt.sha256).toBe(HASH);
  expect(files.download).toHaveBeenCalledTimes(1);
  expect(files.download).toHaveBeenCalledWith('0001', 'saved-file');
  expect(JSON.stringify([...parents])).toBe(before);
});
test('a wrong ancestral digest or omitted invalid checkpoint remains refused', async () => {
  for (const parentSha256 of ['d'.repeat(64), null]) {
    await expect(checkpoints.load({ ...selected, parentSha256 })).rejects.toMatchObject({ code: 'REPORT_CHECKPOINT_CONFLICT' });
  }
  expect(files.download).not.toHaveBeenCalled();
});
test.each(['source', 'scope', 'pending', 'unfinished'])('ancestral recovery retains the %s authority fence', async kind => {
  const first = parents.get('original');
  if (kind === 'source') first.sourceCommit = 'd'.repeat(40);
  if (kind === 'scope') first.specSha256 = 'd'.repeat(64);
  if (kind === 'pending') first.pendingInferences = ['unsettled-call'];
  if (kind === 'unfinished') first.modelReceipts[0].state = 'unknown';
  await expect(checkpoints.load(selected)).rejects.toMatchObject({ code: 'REPORT_CHECKPOINT_CONFLICT' });
  expect(files.download).not.toHaveBeenCalled();
});
test('a nearer saved checkpoint cannot be bypassed to select an older file', async () => {
  parents.get('refused').result.partial = { deliverableId: 'newer-file', sha256: 'e'.repeat(64) };
  await expect(checkpoints.load(selected)).rejects.toMatchObject({ code: 'REPORT_CHECKPOINT_CONFLICT' });
  expect(files.download).not.toHaveBeenCalled();
});
test('an empty terminal lineage permits only an explicitly empty checkpoint', async () => {
  const first = parents.get('original'); first.result = { kind: 'blocked' };
  const empty = { ...selected, parentRequestId: 'original', parentSha256: null };
  expect((await checkpoints.load(empty)).receipt).toBeNull();
  await expect(checkpoints.load({ ...empty, parentSha256: HASH })).rejects.toMatchObject({ code: 'REPORT_CHECKPOINT_CONFLICT' });
});
