'use strict';
const { read } = require('../../src/services/finance/financePublicationEvidence');
function setup(row) {
  const cursor = { sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
    maxTimeMS: jest.fn().mockReturnThis(), next: jest.fn().mockResolvedValue(row) };
  const collection = { find: jest.fn(() => cursor) };
  const withAccess = jest.fn(fn => fn());
  return { cursor, collection, withAccess, deps: { collection: () => collection, withAccess, now: () => new Date('2026-03-15T12:00:00Z') } };
}
test('reads only personal applied receipt timestamp with bounded execution and access guard', async () => {
  const s = setup({ receipt: { appliedAt: '2026-03-01T00:00:00.000Z' } });
  expect(await read(s.deps)).toMatchObject({ status: 'attested',
    lastAppliedAt: '2026-03-01T00:00:00.000Z', lastFailedAt: null });
  expect(s.withAccess).toHaveBeenCalledTimes(1);
  expect(s.collection.find).toHaveBeenCalledWith({
    phase: 'applied', 'candidate.base.ledger': { $ne: 'corp' }, 'receipt.appliedAt': { $type: 'string' }
  }, { projection: { _id: 0, 'receipt.appliedAt': 1 } });
  expect(s.cursor.limit).toHaveBeenCalledWith(1);
  expect(s.cursor.maxTimeMS).toHaveBeenCalledWith(1000);
});
test.each([null, { receipt: { appliedAt: 'invalid' } }, { receipt: { appliedAt: '2099-01-01T00:00:00Z' } }])('missing receipts stay unknown', async row => {
  expect(await read(setup(row).deps)).toMatchObject({ status: 'unknown', lastAppliedAt: null });
});
test('failure and finance exclusion remain unavailable without leaking errors', async () => {
  const s = setup(null);
  s.withAccess.mockRejectedValue(Error('private details'));
  const result = await read(s.deps);
  expect(result).toMatchObject({ status: 'unavailable', lastAppliedAt: null });
  expect(JSON.stringify(result)).not.toContain('private');
  expect(s.collection.find).not.toHaveBeenCalled();
});

test('one-minute future tolerance is consistent with the source projection', async () => {
  expect(await read(setup({ receipt: { appliedAt: '2026-03-15T12:01:00Z' } }).deps))
    .toMatchObject({ status: 'attested', lastAppliedAt: '2026-03-15T12:01:00.000Z' });
  expect(await read(setup({ receipt: { appliedAt: '2026-03-15T12:01:01Z' } }).deps))
    .toMatchObject({ status: 'unknown', lastAppliedAt: null });
});
