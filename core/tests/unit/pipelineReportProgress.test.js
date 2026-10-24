'use strict';
const progress = require('../../src/services/pipelineReportProgress');
const coverage = require('../../src/services/pipelineReportCoverage');
function run(extra = {}) {
  return { pipelineId: '0001', taskId: 'task-one', sourceCommit: 'a'.repeat(40), specSha256: 'b'.repeat(64),
    coverage: { inventorySha256: 'c'.repeat(64), documents: [{ path: 'docs/A.md', sha256: 'd'.repeat(64), state: 'partial',
      evidence: [{ path: 'source.js', sha256: 'e'.repeat(64), line: 1, check: 'Value checked' }], ranges: [] }] }, ...extra };
}
test('administrative bytes, prose and reference wording do not establish new source coverage', () => {
  const before = run(); const after = structuredClone(before);
  after.coverage.documents[0].evidence[0].check = 'Same source, different prose';
  after.coverage.documents[0].note = 'An authorized continuation permits another attempt';
  after.receipts = ['new']; after.partial = { sha256: 'f'.repeat(64) };
  expect(progress.compare(after, before)).toMatchObject({ verified: true, advanced: false, addedUnits: 0 });
  expect(progress.compare(after, before).beforeSha256).toBe(progress.compare(after, before).afterSha256);
});
test('new source lines, accepted ranges and a completed document each establish material progress', () => {
  for (const change of [row => row.evidence.push({ ...row.evidence[0], line: 2 }),
    row => row.ranges.push([1, 20]), row => { row.state = 'reviewed'; }]) {
    const before = run(), after = structuredClone(before); change(after.coverage.documents[0]);
    expect(progress.compare(after, before)).toMatchObject({ verified: true, advanced: true, addedUnits: 1 });
  }
});
test('order, duplicated evidence and lost coverage do not manufacture progress', () => {
  const before = run(); const after = structuredClone(before);
  after.coverage.documents[0].evidence.push(...after.coverage.documents[0].evidence);
  expect(progress.compare(after, before).advanced).toBe(false);
  after.coverage.documents[0].evidence = [];
  expect(progress.compare(after, before).advanced).toBe(false);
});
test('repartitioning the same accepted line coverage does not justify a continuation', () => {
  const before = run(), after = run();
  before.coverage.documents[0].ranges = [[1, 20]];
  after.coverage.documents[0].ranges = [[1, 10], [11, 20]];
  expect(progress.compare(after, before)).toMatchObject({ verified: true, advanced: false });
});
test.each([[[1, 10]], [[2, 19]], [[1, 5], [16, 20]], []].map(ranges => [ranges]))('shrinking accepted ranges %j cannot manufacture progress', ranges => {
  const before = run(), after = run();
  before.coverage.documents[0].ranges = [[1, 20]];
  after.coverage.documents[0].ranges = ranges;
  expect(progress.compare(after, before)).toMatchObject({ verified: true, advanced: false, addedUnits: 0 });
});
test('extending a range or filling its gap advances only if the prior coverage is preserved', () => {
  const before = run(), after = run();
  before.coverage.documents[0].ranges = [[1, 5], [10, 20]];
  after.coverage.documents[0].ranges = [[1, 20]];
  expect(progress.compare(after, before)).toMatchObject({ advanced: true, addedUnits: 1, removedUnits: 0 });
  after.coverage.documents[0].ranges = [[2, 30]];
  expect(progress.compare(after, before)).toMatchObject({ advanced: false, reason: 'coverage_regressed' });
});
test('missing parent coverage and changed scope fail closed; a fresh empty run makes no progress', () => {
  expect(progress.compare(run(), run({ sourceCommit: 'f'.repeat(40) })).verified).toBe(false);
  expect(progress.compare(run(), run({ coverage: null })).verified).toBe(false);
  const empty = run(); empty.coverage.documents[0].evidence = [];
  expect(progress.compare(empty)).toMatchObject({ verified: true, advanced: false });
  expect(progress.compare(run())).toMatchObject({ verified: true, advanced: true });
});
test('Core validates and preserves range coverage instead of trusting arbitrary intervals', () => {
  const snapshot = coverage.inventory({ sourceCommit: 'a'.repeat(40), documents: [{ path: 'docs/A.md', sha256: 'd'.repeat(64) }] }, 'a'.repeat(40));
  const value = run().coverage; value.inventorySha256 = snapshot.sha256;
  value.documents[0].ranges = [[1, 20], [21, 40]];
  expect(coverage.coverage(value, snapshot).documents[0].ranges).toEqual([[1, 20], [21, 40]]);
  for (const spans of [[[0, 20]], [[1, 20], [20, 30]], [[2, 1]], [[1, 2.1]], [[1, 1000001]], ['invalid']]) {
    value.documents[0].ranges = spans;
    expect(() => coverage.coverage(value, snapshot)).toThrow('ranges');
  }
});
