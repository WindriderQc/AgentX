'use strict';

jest.mock('../../../models/BenchmarkBatch', () => ({ findOneAndUpdate: jest.fn() }));
for (const name of ['BenchmarkResult', 'JudgeAccuracyMatrix', 'JudgeGovernanceRun', 'JudgeGroundTruth']) {
  jest.doMock(`../../../models/${name}`, () => ({ updateMany: jest.fn(async () => ({ modifiedCount: 0 })) }));
}
const Batch = require('../../../models/BenchmarkBatch');
const children = ['BenchmarkResult', 'JudgeAccuracyMatrix', 'JudgeGovernanceRun', 'JudgeGroundTruth']
  .map(name => require(`../../../models/${name}`));
const { invalidateResource } = require('../../../src/services/benchmark/authorityResourceInvalidation');

beforeEach(() => jest.clearAllMocks());

it('reconciles a legacy standalone campaign ID without casting it to a batch ObjectId or creating a batch', async () => {
  const record = { kind: 'workload_invalidation', resourceType: 'BenchmarkWorkload',
    workloadId: 'toolcall-synthetic', resultId: 'workload:toolcall-synthetic', batchId: 'toolcall-synthetic' };
  const receipt = await invalidateResource(record);
  expect(Batch.findOneAndUpdate).not.toHaveBeenCalled();
  expect(receipt).toMatchObject({ contract: 'agentx.authority-compensation/v1',
    state: 'authority_invalidated', workloadId: record.workloadId,
    affected: { batch: 0, results: 0, matrices: 0, governance: 0, groundTruth: 0 } });
  for (const model of children) expect(model.updateMany).toHaveBeenCalledTimes(1);
});

it('preserves invalidation of an actual batch and its linked projections', async () => {
  Batch.findOneAndUpdate.mockReturnValue({ lean: async () => ({ __v: 4 }) });
  const receipt = await invalidateResource({ kind: 'workload_invalidation', batchId: '0123456789abcdef01234567' });
  expect(Batch.findOneAndUpdate).toHaveBeenCalledTimes(1);
  expect(receipt).toMatchObject({ affected: { batch: 1 }, afterVersion: 4 });
  for (const model of children) expect(model.updateMany).toHaveBeenCalledTimes(1);
});

it('a standalone workload without a batch records compensation without mutating any batch projection', async () => {
  const receipt = await invalidateResource({ kind: 'workload_invalidation', batchId: null });
  expect(receipt.affected).toEqual({ batch: 0, results: 0, matrices: 0, governance: 0, groundTruth: 0 });
  expect(Batch.findOneAndUpdate).not.toHaveBeenCalled();
  for (const model of children) expect(model.updateMany).not.toHaveBeenCalled();
});
