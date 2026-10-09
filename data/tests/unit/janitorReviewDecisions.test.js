/**
 * Duplicate-review decisions: the rules shared with the Core relay, staleness
 * and the report summary. Synthetic paths and hashes only.
 */
const fs = require('node:fs');
const path = require('node:path');
const rules = require('../../../shared/janitorReviewDecisionRules');
const decisions = require('../../services/janitorReviewDecisions');
const groupPages = require('../../services/janitorStrategyGroupPages');
const { SHARED_ROOTS } = require('../../services/janitorStrategyPolicy');

const SHA = 'a'.repeat(64);
const A = '/mnt/datalake/example/a.bin';
const B = '/mnt/datalake/example/copy/a.bin';
const C = '/mnt/media/example/a.bin';

function body(overrides = {}) {
  return { decision: 'dedupe', survivorPath: A, evidence: { size: 1000, paths: [B, A] }, ...overrides };
}

function stored(overrides = {}) {
  return {
    _id: SHA, decision: 'dedupe', survivorPath: A, note: null, source: 'toolbox', decidedAt: new Date('2026-01-02T00:00:00Z'),
    evidence: { size: 1000, paths: [A, B], reportId: null, reportGeneratedAt: null },
    ...overrides
  };
}

const group = (paths, size = 1000) => ({ sha256: SHA, size, count: paths.length, files: paths.map((value) => ({ path: value, mtime: 10 })) });

describe('decision rules', () => {
  test('the shared rules and Data name the same roots', () => {
    expect([...rules.SHARED_DRIVE_ROOTS]).toEqual([...SHARED_ROOTS]);
  });

  test('a valid decision is normalized: sorted paths, trimmed note, hash from the address', () => {
    const checked = rules.checkDecision(body({ note: '  keep the ISO folder  ' }), { sha256: SHA });
    expect(checked.errors).toEqual([]);
    expect(checked.value).toEqual({
      sha256: SHA, decision: 'dedupe', survivorPath: A, note: 'keep the ISO folder', source: 'toolbox',
      evidence: { size: 1000, paths: [A, B], reportId: null, reportGeneratedAt: null }
    });
  });

  test.each([
    ['unknown key', body({ approve: true }), /unknown decision field "approve"/],
    ['unknown evidence key', body({ evidence: { size: 1, paths: [A, B], previewId: 'x' } }), /unknown evidence field "previewId"/],
    ['unknown decision', body({ decision: 'delete' }), /decision must be one of keep_all, dedupe, defer/],
    ['survivor outside the group', body({ survivorPath: C }), /survivorPath must be one of evidence\.paths/],
    ['dedupe without survivor', body({ survivorPath: undefined }), /survivorPath is required/],
    ['survivor on keep_all', body({ decision: 'keep_all' }), /only accepted when decision is dedupe/],
    ['path outside the roots', body({ evidence: { size: 1, paths: [A, '/etc/passwd'] } }), /must be under one of \/mnt\/media, \/mnt\/datalake/],
    ['path that climbs out', body({ evidence: { size: 1, paths: [A, '/mnt/datalake/../etc/passwd'] } }), /must be normalized/],
    ['root look-alike', body({ evidence: { size: 1, paths: [A, '/mnt/datalake-other/a'] } }), /must be under one of/],
    ['relative path', body({ evidence: { size: 1, paths: [A, 'mnt/datalake/a'] } }), /absolute path/],
    ['NUL in a path', body({ evidence: { size: 1, paths: [A, '/mnt/datalake/a\u0000b'] } }), /NUL/],
    ['oversized path', body({ evidence: { size: 1, paths: [A, `/mnt/datalake/${'x'.repeat(1100)}`] } }), /at most 1024 bytes/],
    ['a single path', body({ evidence: { size: 1, paths: [A] } }), /from 2 to 500 paths/],
    ['too many paths', body({ evidence: { size: 1, paths: Array.from({ length: 501 }, (_, i) => `/mnt/datalake/f${i}`) } }), /from 2 to 500 paths/],
    ['repeated path', body({ evidence: { size: 1, paths: [A, A] } }), /must not repeat a path/],
    ['zero size', body({ evidence: { size: 0, paths: [A, B] } }), /evidence\.size/],
    ['fractional size', body({ evidence: { size: 1.5, paths: [A, B] } }), /evidence\.size/],
    ['unsafe size', body({ evidence: { size: 2 ** 60, paths: [A, B] } }), /evidence\.size/],
    ['string size', body({ evidence: { size: '1000', paths: [A, B] } }), /evidence\.size/],
    ['long note', body({ note: 'x'.repeat(501) }), /note must be at most 500/],
    ['non-text note', body({ note: { $ne: 1 } }), /note must be text/],
    ['bad report id', body({ evidence: { size: 1, paths: [A, B], reportId: 'latest' } }), /reportId/],
    ['bad report date', body({ evidence: { size: 1, paths: [A, B], reportGeneratedAt: 'yesterday' } }), /reportGeneratedAt/],
    ['unknown source', body({ source: 'robot' }), /source must be one of/],
    ['hash differs from the address', body({ sha256: 'b'.repeat(64) }), /must match the one in the address/],
    ['array body', [], /must be a JSON object/]
  ])('refuses %s', (_name, input, message) => {
    const checked = rules.checkDecision(input, { sha256: SHA });
    expect(checked.value).toBeNull();
    expect(checked.errors.join(' | ')).toMatch(message);
  });

  test('a hash must be 64 lowercase hexadecimal characters', () => {
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'hash-still-visible', { $gt: '' }, undefined]) {
      expect(rules.checkDecision(body(), { sha256: bad }).errors.join(' ')).toMatch(/sha256 must be 64 lowercase/);
    }
  });

  test('a batch is bounded and all-or-nothing', () => {
    const one = (index, extra = {}) => ({ sha256: index.toString(16).padStart(64, '0'), ...body(), ...extra });
    expect(rules.checkBatch({ decisions: [one(1), one(2)], mode: 'insert_missing' }).value.decisions).toHaveLength(2);
    expect(rules.checkBatch({ decisions: Array.from({ length: 200 }, (_, i) => one(i)) }).errors).toEqual([]);
    expect(rules.checkBatch({ decisions: Array.from({ length: 201 }, (_, i) => one(i)) }).errors[0]).toMatch(/from 1 to 200 decisions/);
    expect(rules.checkBatch({ decisions: [] }).errors[0]).toMatch(/from 1 to 200 decisions/);
    expect(rules.checkBatch({ decisions: [one(1), one(1)] }).errors[0]).toMatch(/more than once/);
    expect(rules.checkBatch({ decisions: [one(1)], mode: 'replace_all' }).errors[0]).toMatch(/mode must be one of/);
    expect(rules.checkBatch({ decisions: [one(1)], confirm: true }).errors[0]).toMatch(/unknown batch field "confirm"/);
    const mixed = rules.checkBatch({ decisions: [one(1), one(2, { decision: 'delete' })] });
    expect(mixed.value).toBeNull();
    expect(mixed.errors[0]).toMatch(/^decisions\[1\]: decision must be one of/);
    // The answer stays bounded even when every entry is wrong.
    const allBad = rules.checkBatch({ decisions: Array.from({ length: 200 }, () => ({})) });
    expect(allBad.errors.length).toBeLessThanOrEqual(31);
    expect(allBad.errors.at(-1)).toBe('190 more invalid decisions');
  });

  test('list filters are allowlisted and bounded', () => {
    expect(rules.checkListQuery({}).value).toEqual({ decision: null, state: null, pathPrefix: null, sha256: null, limit: 50, offset: 0 });
    expect(rules.checkListQuery({ decision: 'dedupe', state: 'stale', pathPrefix: '/mnt/media/', limit: '200', offset: '5', sha256: `${SHA},${SHA}` }).value)
      .toEqual({ decision: 'dedupe', state: 'stale', pathPrefix: '/mnt/media', sha256: [SHA], limit: 200, offset: 5 });
    for (const [query, message] of [
      [{ limit: '201' }, /limit must be a whole number from 1 to 200/],
      [{ limit: '0' }, /limit/], [{ offset: '-1' }, /offset/], [{ decision: 'delete' }, /decision must be one of/],
      [{ state: 'fresh' }, /state must be one of/], [{ pathPrefix: '/etc' }, /pathPrefix must be under/],
      [{ pathPrefix: '/mnt/media/../..' }, /normalized/], [{ sha256: 'nope' }, /sha256 must be at most 100/],
      [{ sha256: Array.from({ length: 101 }, () => SHA).join(',') }, /at most 100/], [{ sort: 'x' }, /unknown query field "sort"/]
    ]) expect(rules.checkListQuery(query).errors.join(' ')).toMatch(message);
  });

  test('the groups page query is bounded', () => {
    expect(groupPages.checkPageQuery({}).value).toEqual({ offset: 0, limit: 30, review: 'all', sha256: null });
    expect(groupPages.checkPageQuery({ offset: '60', limit: '50', review: 'undecided' }).value).toEqual({ offset: 60, limit: 50, review: 'undecided', sha256: null });
    expect(groupPages.checkPageQuery({ sha256: `${SHA},${SHA}` }).value.sha256).toEqual([SHA]);
    expect(groupPages.checkPageQuery({ sha256: Array.from({ length: 51 }, () => SHA).join(',') }).errors[0]).toMatch(/at most 50 comma-separated/);
    expect(groupPages.checkPageQuery({ sha256: '$where' }).errors[0]).toMatch(/sha256/);
    expect(groupPages.checkPageQuery({ limit: '51' }).errors[0]).toMatch(/limit must be a whole number from 1 to 50/);
    expect(groupPages.checkPageQuery({ limit: '1e3' }).errors[0]).toMatch(/limit/);
    expect(groupPages.checkPageQuery({ review: 'everything' }).errors[0]).toMatch(/review must be one of all, undecided/);
    expect(groupPages.checkPageQuery({ files: '9999' }).errors[0]).toMatch(/unknown query field "files"/);
  });
});

describe('staleness', () => {
  const decision = decisions.publicDecision(stored());
  const codes = (result) => result.reasons.map((entry) => entry.code);

  test('a decision that still fits its group is current, whatever the order of the copies', () => {
    expect(decisions.evaluateDecision(decision, group([B, A]))).toEqual({ state: 'current', reasons: [] });
  });

  test('a copy that is gone makes it stale', () => {
    const result = decisions.evaluateDecision(decision, group([A, C]));
    expect(result.state).toBe('stale');
    expect(codes(result)).toEqual(['path_missing', 'new_copies']);
    expect(result.reasons[0]).toMatchObject({ count: 1, paths: [B] });
  });

  test('a new copy makes it stale', () => {
    expect(codes(decisions.evaluateDecision(decision, group([A, B, C])))).toEqual(['new_copies']);
  });

  test('a missing survivor is named', () => {
    const result = decisions.evaluateDecision(decision, group([B, C]));
    expect(codes(result)).toEqual(['path_missing', 'new_copies', 'survivor_missing']);
    expect(result.reasons[2].paths).toEqual([A]);
  });

  test('a group that no longer exists, or shrank to one copy, is not a verified group', () => {
    expect(codes(decisions.evaluateDecision(decision, null))).toEqual(['group_not_verified', 'path_missing', 'survivor_missing']);
    expect(codes(decisions.evaluateDecision(decision, group([A])))).toEqual(['group_not_verified', 'path_missing']);
  });

  test('a changed size is stale', () => {
    expect(codes(decisions.evaluateDecision(decision, group([A, B], 2000)))).toEqual(['size_changed']);
  });

  test('with index evidence, a copy whose content changed is told apart from one that is gone', () => {
    const pathStates = new Map([[A, { exists: true }], [B, { exists: true, sha256: 'c'.repeat(64) }]]);
    const result = decisions.evaluateDecision(decision, group([A, C]), { pathStates });
    expect(codes(result)).toEqual(['hash_changed', 'new_copies']);
    expect(result.reasons[0].paths).toEqual([B]);
  });

  test('keep_all and defer have no survivor to lose', () => {
    const keepAll = decisions.publicDecision(stored({ decision: 'keep_all', survivorPath: null }));
    expect(decisions.evaluateDecision(keepAll, group([A, B])).state).toBe('current');
    expect(codes(decisions.evaluateDecision(keepAll, group([A, B, C])))).toEqual(['new_copies']);
  });

  test('reasons list at most three paths and keep the count', () => {
    const many = Array.from({ length: 20 }, (_, index) => `/mnt/media/new/${index}`);
    const result = decisions.evaluateDecision(decision, group([A, B, ...many]));
    expect(result.reasons[0]).toMatchObject({ code: 'new_copies', count: 20 });
    expect(result.reasons[0].paths).toHaveLength(3);
  });
});

describe('report summary', () => {
  const policy = { duplicateSurvivor: 'canonical_active' };
  const other = 'b'.repeat(64);
  const gone = 'c'.repeat(64);

  test('counts by decision, the bytes dedupe decisions represent, and what went stale', () => {
    const docs = [
      stored(),
      stored({ _id: other, decision: 'keep_all', survivorPath: null, evidence: { size: 5, paths: ['/mnt/media/x', '/mnt/media/y'] } }),
      stored({ _id: gone, evidence: { size: 7, paths: ['/mnt/media/p', '/mnt/media/q'] }, survivorPath: '/mnt/media/p' })
    ];
    const groups = [group([A, B]), { sha256: other, size: 5, files: [{ path: '/mnt/media/x' }, { path: '/mnt/media/y' }, { path: '/mnt/media/z' }] }];
    const { summary, marks } = decisions.summarizeForReport(docs, groups, policy);
    expect(summary).toMatchObject({
      reference: 'report-groups', authorizesFilesystemMutation: false, total: 3, evaluated: 3, truncated: false,
      byDecision: { keep_all: 1, dedupe: 2, defer: 0 }, current: 1, stale: 2, inReport: 2, notInReport: 1,
      dedupe: { current: 1, stale: 1, reclaimableBytes: 1000, survivorDiffersFromPolicy: 0 }
    });
    expect(summary.staleByReason).toMatchObject({ new_copies: 1, group_not_verified: 1 });
    expect(marks.get(SHA)).toMatchObject({ decision: 'dedupe', state: 'current', policySurvivorPath: A, survivorDiffersFromPolicy: false });
    expect(marks.has(gone)).toBe(false);
  });

  test('an owner survivor that differs from the policy is shown next to it, not replaced', () => {
    const { summary, marks } = decisions.summarizeForReport([stored({ survivorPath: B })], [group([A, B])], policy);
    expect(marks.get(SHA)).toMatchObject({ survivorPath: B, policySurvivorPath: A, survivorDiffersFromPolicy: true });
    expect(summary.dedupe.survivorDiffersFromPolicy).toBe(1);
    // No rule chosen yet: there is no policy survivor to compare with.
    const noRule = decisions.summarizeForReport([stored({ survivorPath: B })], [group([A, B])], { duplicateSurvivor: null });
    expect(noRule.marks.get(SHA)).toMatchObject({ policySurvivorPath: null, survivorDiffersFromPolicy: false });
  });

  test('a report is still produced when the decisions cannot be read', async () => {
    const broken = { collection() { throw new Error('database offline'); } };
    const report = { generatedAt: new Date(), evidence: { verifiedDuplicateEvidence: [group([A, B])] } };
    expect(await decisions.reportSummary(broken, report)).toMatchObject({ status: 'unavailable', message: 'database offline' });
    const annotated = await decisions.annotateStrategyReport(broken, report);
    expect(annotated.reviewDecisions.status).toBe('unavailable');
    expect(annotated.evidence.verifiedDuplicateEvidence).toEqual(report.evidence.verifiedDuplicateEvidence);
  });
});

describe('a decision is intent only', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');

  test('the decision code cannot reach the run store, the cleanup service or the filesystem', () => {
    for (const file of ['services/janitorReviewDecisions.js', 'services/janitorStrategyGroupPages.js', 'controllers/janitorReviewDecisionsController.js']) {
      const requires = [...read(file).matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
      for (const forbidden of ['janitorRunner', 'janitorService', 'janitorApprovalEvidence', 'file-operations', 'fs', 'node:fs', 'child_process']) {
        expect(requires.filter((name) => name === forbidden || name.endsWith(`/${forbidden}`))).toEqual([]);
      }
      // Comments explain the boundary and may name these; the code must not.
      const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toMatch(/janitor_runs|approveAction|executeCleanup|approval_preview|unlink|rename\(/);
    }
  });

  test('the approval and execution code never reads a stored decision', () => {
    for (const file of ['services/janitorRunner.js', 'services/janitorService.js', 'services/janitorApprovalEvidence.js']) {
      expect(read(file)).not.toMatch(/janitorReviewDecisions|janitor_review_decisions|review-decisions/);
    }
  });

  test('every stored decision says it authorizes nothing', () => {
    expect(decisions.publicDecision(stored()).authorizesFilesystemMutation).toBe(false);
    expect(decisions.publicDecision(stored({ authorizesFilesystemMutation: true })).authorizesFilesystemMutation).toBe(false);
  });
});
