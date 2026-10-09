const EventEmitter = require('events');
const { ObjectId } = require('mongodb');

jest.mock('../../services/janitorProfiles', () => ({
  get: jest.fn(),
  checkRoots: jest.fn(),
  COLLECTION: 'janitor_profiles'
}));
jest.mock('../../services/scanner', () => {
  const EventEmitter = require('events');
  const instances = [];
  class MockScanner extends EventEmitter {
    constructor(db) { super(); this.db = db; instances.push(this); }
    async run(opts) {
      this.lastOpts = opts;
      // Simulate async scan completion
      setImmediate(() => this.emit('done', { status: 'complete', counts: { files_seen: 10, hashed: 5, errors: 0 } }));
    }
    stop() { this.stopped = true; }
  }
  return { Scanner: MockScanner, _instances: instances };
});
jest.mock('../../services/dedupScanner', () => ({
  buildDedupReport: jest.fn(),
  saveReport: jest.fn()
}));
// janitorService is used by approveAction (executeCleanup, generateCleanupToken)
// and is not mocked here — those functions are pure and don't need stubs for
// the runProfile tests below.
jest.mock('../../services/janitorApprovalEvidence', () => ({
  ...jest.requireActual('../../services/janitorApprovalEvidence'),
  verifyDuplicateAction: jest.fn()
}));
jest.mock('../../services/janitorAI', () => ({
  callAI: jest.fn()
}));
jest.mock('../../services/janitorStrategy', () => ({
  ...jest.requireActual('../../services/janitorStrategy'),
  getPolicy: jest.fn()
}));

const janitorProfiles = require('../../services/janitorProfiles');
const scannerMod = require('../../services/scanner');
const dedupScanner = require('../../services/dedupScanner');
const janitorAI = require('../../services/janitorAI');
const janitorStrategy = require('../../services/janitorStrategy');
const janitorRunner = require('../../services/janitorRunner');
const janitorService = require('../../services/janitorService');
const janitorApprovalEvidence = require('../../services/janitorApprovalEvidence');

const DUPLICATE_SHA256 = 'a'.repeat(64);

function getPath(value, dottedPath) {
  return dottedPath.split('.').reduce((current, key) => current?.[key], value);
}

function setPath(value, dottedPath, nextValue) {
  const keys = dottedPath.split('.');
  let current = value;
  for (const key of keys.slice(0, -1)) {
    if (current[key] == null) current[key] = {};
    current = current[key];
  }
  current[keys[keys.length - 1]] = nextValue;
}

function matches(doc, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = getPath(doc, key);
    if (expected && typeof expected === 'object' && '$gt' in expected) {
      return new Date(actual).getTime() > new Date(expected.$gt).getTime();
    }
    return String(actual) === String(expected);
  });
}

function cloneRun(doc) {
  return {
    ...doc,
    proposed_actions: doc.proposed_actions?.map(action => ({
      ...action,
      files: action.files ? [...action.files] : action.files,
      approval_preview: action.approval_preview ? {
        ...action.approval_preview,
        restore_source: action.approval_preview.restore_source
          ? { ...action.approval_preview.restore_source }
          : action.approval_preview.restore_source,
        targets: action.approval_preview.targets?.map(target => ({ ...target }))
      } : action.approval_preview
    }))
  };
}

function makeMockDb() {
  const collections = {};
  return {
    _collections: collections,
    collection: jest.fn((name) => {
      if (!collections[name]) {
        collections[name] = {
          docs: [],
          insertOne: jest.fn(async (doc) => {
            const _id = new ObjectId();
            collections[name].docs.push({ ...doc, _id });
            return { insertedId: _id };
          }),
          updateOne: jest.fn(async (filter, update) => {
            const idx = collections[name].docs.findIndex(d => matches(d, filter));
            if (idx !== -1) {
              if (update.$set) {
                for (const [key, value] of Object.entries(update.$set)) {
                  setPath(collections[name].docs[idx], key, value);
                }
              }
            }
            return { matchedCount: idx === -1 ? 0 : 1, modifiedCount: idx === -1 ? 0 : 1 };
          }),
          findOne: jest.fn(async (filter) => {
            const doc = collections[name].docs.find(d => matches(d, filter));
            return doc ? cloneRun(doc) : null;
          })
        };
      }
      return collections[name];
    })
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  scannerMod._instances.length = 0;
  janitorRunner._reset(); // clear in-memory concurrency guard
  janitorProfiles.checkRoots.mockResolvedValue({ ok: true });
  janitorApprovalEvidence.verifyDuplicateAction.mockResolvedValue(previewEvidence());
  janitorStrategy.getPolicy.mockResolvedValue({
    version: 1,
    duplicateSurvivor: 'newest',
    backupRetention: 'staging',
    generatedCache: 'review_rebuildable',
    maintenanceAuthorization: 'explicit_per_action'
  });
});

const profileFixture = {
  _id: new ObjectId(),
  name: 'Test Profile',
  roots: ['/mnt/datalake/test'],
  extensions: { include: [], exclude: [] },
  computeHashes: true,
  policies: ['delete_duplicates'],
  aiTriage: false
};

const originalExecutionEnabled = process.env.JANITOR_EXECUTION_ENABLED;
const originalPreviewTtl = process.env.JANITOR_PREVIEW_TTL_MS;

afterEach(() => {
  if (originalExecutionEnabled === undefined) delete process.env.JANITOR_EXECUTION_ENABLED;
  else process.env.JANITOR_EXECUTION_ENABLED = originalExecutionEnabled;
  if (originalPreviewTtl === undefined) delete process.env.JANITOR_PREVIEW_TTL_MS;
  else process.env.JANITOR_PREVIEW_TTL_MS = originalPreviewTtl;
  jest.restoreAllMocks();
});

function seedPendingAction(db, overrides = {}) {
  const runId = new ObjectId();
  const action = {
    type: 'verified_duplicate_review',
    policy: 'delete_duplicates',
    sha256: DUPLICATE_SHA256,
    keep: { path: '/mnt/datalake/keep.txt' },
    candidatesToRemove: [{ path: '/mnt/datalake/dup.txt' }],
    files: ['/mnt/datalake/dup.txt'],
    status: 'pending',
    execution_authorized: false,
    ...overrides
  };
  db.collection(janitorRunner.COLLECTION).docs.push({
    _id: runId,
    status: 'complete',
    proposed_actions: [action]
  });
  return { runId, action };
}

function previewEvidence() {
  return {
    ok: true,
    proof: 'complete-sha256-all-members',
    sha256: DUPLICATE_SHA256,
    verified_at: new Date('2026-07-18T12:00:00.000Z'),
    survivor: {
      file: '/mnt/datalake/keep.txt',
      real_path: '/mnt/datalake/keep.txt',
      size: 100,
      mtime_ms: 900,
      sha256: DUPLICATE_SHA256
    },
    targets: [{
      file: '/mnt/datalake/dup.txt',
      real_path: '/mnt/datalake/dup.txt',
      size: 100,
      mtime_ms: 1000,
      sha256: DUPLICATE_SHA256
    }]
  };
}

function previewResult(file = '/mnt/datalake/dup.txt') {
  return {
    ok: true,
    dry_run: true,
    total_files: 1,
    deleted: [{
      file,
      action: 'would_delete',
      real_path: file,
      size: 100,
      mtime_ms: 1000
    }],
    skipped: [],
    failed: [],
    space_freed: 100
  };
}

describe('janitorRunner.runProfile', () => {
  test('stores a bounded prefix of the proposed actions and counts the rest', async () => {
    janitorProfiles.get.mockResolvedValue({ ...profileFixture });
    const total = janitorRunner.MAX_PROPOSED_ACTIONS + 3;
    const groups = Array.from({ length: total }, (_, group) => ({
      hash: `group-${group}`, count: 2, file_size: 100,
      files: [0, 1].map(copy => ({ path: `/mnt/datalake/test/group-${group}-copy-${copy}.txt`, mtime: copy + 1, size: 100 }))
    }));
    dedupScanner.buildDedupReport.mockResolvedValue({ groups, summary: {} });
    dedupScanner.saveReport.mockResolvedValue(new ObjectId());
    const db = makeMockDb();
    await janitorRunner.runProfile(db, String(profileFixture._id));
    const run = db._collections.janitor_runs.docs[0];
    expect(run.status).toBe('complete');
    expect(run.proposed_actions).toHaveLength(janitorRunner.MAX_PROPOSED_ACTIONS);
    expect(run.proposed_actions_omitted).toBe(3);
    // The stored actions are the first ones, so approval indexes stay stable.
    expect(run.proposed_actions[0].sha256).toBe('group-0');
    expect(run.proposed_actions.at(-1).sha256).toBe(`group-${janitorRunner.MAX_PROPOSED_ACTIONS - 1}`);
  });

  test('stops storing proposed actions at the byte budget', async () => {
    janitorProfiles.get.mockResolvedValue({ ...profileFixture });
    const longName = 'x'.repeat(512 * 1024);
    const groups = Array.from({ length: 9 }, (_, group) => ({
      hash: `group-${group}`, count: 2, file_size: 100,
      files: [0, 1].map(copy => ({ path: `/mnt/datalake/test/${longName}-${group}-${copy}`, mtime: copy + 1, size: 100 }))
    }));
    dedupScanner.buildDedupReport.mockResolvedValue({ groups, summary: {} });
    dedupScanner.saveReport.mockResolvedValue(new ObjectId());
    const db = makeMockDb();
    await janitorRunner.runProfile(db, String(profileFixture._id));
    const run = db._collections.janitor_runs.docs[0];
    expect(run.proposed_actions.length).toBeGreaterThan(0);
    expect(run.proposed_actions_omitted).toBeGreaterThan(0);
    expect(run.proposed_actions.length + run.proposed_actions_omitted).toBe(9);
    expect(Buffer.byteLength(JSON.stringify(run.proposed_actions))).toBeLessThanOrEqual(janitorRunner.MAX_PROPOSED_ACTIONS_BYTES);
  });

  test('triage declares both sample limits while preserving every proposal and file for review', async () => {
    janitorProfiles.get.mockResolvedValue({ ...profileFixture, aiTriage: true });
    const groups = Array.from({ length: 70 }, (_, group) => ({
      hash: `group-${group}`, count: 11, file_size: 100,
      files: Array.from({ length: 11 }, (_, copy) => ({
        path: `/mnt/datalake/test/group-${group}-copy-${copy}.txt`, mtime: copy + 1, size: 100
      }))
    }));
    dedupScanner.buildDedupReport.mockResolvedValue({ groups, summary: {} });
    dedupScanner.saveReport.mockResolvedValue(new ObjectId());
    janitorAI.callAI.mockResolvedValue({ result: { categories: [] }, model: 'test-model', duration_ms: 1 });
    const db = makeMockDb();
    await janitorRunner.runProfile(db, String(profileFixture._id));
    const run = db._collections.janitor_runs.docs[0];
    expect(run.proposed_actions).toHaveLength(70);
    expect(run.proposed_actions_omitted).toBe(0);
    expect(run.proposed_actions.every(action => action.files.length === 10)).toBe(true);
    expect(run.proposed_actions.flatMap(action => action.files)).toContain('/mnt/datalake/test/group-69-copy-9.txt');
    expect(run.ai_triage.coverage).toMatchObject({ complete: false,
      actions: { included: 50, available: 70 }, fileEntries: { included: 250, available: 700 } });
    const submitted = janitorAI.callAI.mock.calls[0][1];
    expect(submitted.files).toHaveLength(50);
    expect(submitted.files.every(action => action.files.length === 5)).toBe(true);
    expect(submitted.coverage).toEqual(run.ai_triage.coverage);
  });

  test('happy path: scan → dedup → persist run as complete', async () => {
    janitorProfiles.get.mockResolvedValue(profileFixture);
    // Dedup returns one current SHA group. The explicitly persisted `newest`
    // survivor rule keeps mtime 200 and proposes the older copy for review.
    dedupScanner.buildDedupReport.mockResolvedValue({
      groups: [{
        hash: 'abc123',
        count: 2,
        file_size: 500,
        files: [
          { path: '/mnt/datalake/old.txt', mtime: 100, size: 500 },
          { path: '/mnt/datalake/new.txt', mtime: 200, size: 500 }
        ]
      }],
      summary: { total_duplicate_groups: 1, total_duplicate_files: 2, total_wasted_space: 500 }
    });
    dedupScanner.saveReport.mockResolvedValue(new ObjectId());

    const db = makeMockDb();
    const result = await janitorRunner.runProfile(db, String(profileFixture._id));

    expect(result.ok).toBe(true);
    expect(result.run_id).toBeDefined();

    const runs = db._collections['janitor_runs'].docs;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('complete');
    expect(runs[0].profile_name).toBe('Test Profile');
    expect(runs[0].proposed_actions).toHaveLength(1);
    const action = runs[0].proposed_actions[0];
    expect(action.policy).toBe('delete_duplicates');
    expect(action.files).toEqual(['/mnt/datalake/old.txt']);
    expect(action.reason).toContain('/mnt/datalake/new.txt');
    expect(action.survivorRule).toBe('newest');
    expect(action.evidence).toBe('sha256-current-metadata');
    expect(action.approval_required).toBe(true);
    expect(action.execution_authorized).toBe(false);
    expect(action.status).toBe('pending');
    expect(action.executed_at).toBeNull();
    expect(action.result).toBeNull();
    expect(runs[0].strategy_status).toBe('ready_for_review');
    expect(runs[0].decisions_required).toEqual([]);
  });

  test('incomplete shared-drive policy produces decisions and zero actions', async () => {
    janitorProfiles.get.mockResolvedValue(profileFixture);
    janitorStrategy.getPolicy.mockResolvedValueOnce(janitorStrategy.defaultPolicy());
    dedupScanner.buildDedupReport.mockResolvedValue({
      groups: [{
        hash: 'abc123', count: 2, file_size: 500,
        files: [
          { path: '/mnt/datalake/a.txt', mtime: 100, size: 500 },
          { path: '/mnt/datalake/b.txt', mtime: 200, size: 500 }
        ]
      }],
      summary: { total_duplicate_groups: 1, total_duplicate_files: 2, total_wasted_space: 500 }
    });
    dedupScanner.saveReport.mockResolvedValue(new ObjectId());

    const db = makeMockDb();
    const result = await janitorRunner.runProfile(db, String(profileFixture._id));
    const run = db._collections['janitor_runs'].docs[0];

    expect(result.ok).toBe(true);
    expect(run.strategy_status).toBe('awaiting_policy');
    expect(run.decisions_required.map(item => item.field)).toEqual([
      'duplicateSurvivor', 'backupRetention', 'generatedCache'
    ]);
    expect(run.proposed_actions).toEqual([]);
  });

  test('returns notFound when profile does not exist', async () => {
    janitorProfiles.get.mockResolvedValue(null);
    const db = makeMockDb();
    const result = await janitorRunner.runProfile(db, String(new ObjectId()));
    expect(result.ok).toBe(false);
    expect(result.notFound).toBe(true);
  });

  test('concurrency guard rejects a 2nd call for the same profile', async () => {
    janitorProfiles.get.mockResolvedValue(profileFixture);
    dedupScanner.buildDedupReport.mockResolvedValue({ groups: [], summary: {} });
    dedupScanner.saveReport.mockResolvedValue(new ObjectId());

    const db = makeMockDb();
    const first = janitorRunner.runProfile(db, String(profileFixture._id));
    const second = await janitorRunner.runProfile(db, String(profileFixture._id));

    expect(second.ok).toBe(false);
    expect(second.alreadyRunning).toBe(true);
    await first;
  });

  test('AI triage failure does not fail the run', async () => {
    janitorProfiles.get.mockResolvedValue({ ...profileFixture, aiTriage: true });
    dedupScanner.buildDedupReport.mockResolvedValue({ groups: [], summary: {} });
    dedupScanner.saveReport.mockResolvedValue(new ObjectId());
    janitorAI.callAI.mockRejectedValue(new Error('Ollama unreachable'));

    const db = makeMockDb();
    const result = await janitorRunner.runProfile(db, String(profileFixture._id));

    expect(result.ok).toBe(true);
    const run = db._collections['janitor_runs'].docs[0];
    expect(run.status).toBe('complete');
    expect(run.ai_triage).toMatchObject({ error: 'Ollama unreachable', outcome: 'failed',
      coverage: { actions: { included: 0, available: 0 }, fileEntries: { included: 0, available: 0 } } });
  });

  test('dedup failure recorded but run completes', async () => {
    janitorProfiles.get.mockResolvedValue(profileFixture);
    dedupScanner.buildDedupReport.mockRejectedValue(new Error('agg failed'));

    const db = makeMockDb();
    const result = await janitorRunner.runProfile(db, String(profileFixture._id));

    expect(result.ok).toBe(true);
    const run = db._collections['janitor_runs'].docs[0];
    expect(run.status).toBe('complete');
    expect(run.dedup_error).toBe('agg failed');
  });

  test('a missing root fails the run before any scan, dedup or proposal', async () => {
    janitorProfiles.get.mockResolvedValue(profileFixture);
    janitorProfiles.checkRoots.mockResolvedValue({ ok: false, errors: ['root "/mnt/datalake/test": Path not found'] });
    const db = makeMockDb();

    const result = await janitorRunner.runProfile(db, String(profileFixture._id));

    expect(janitorProfiles.checkRoots).toHaveBeenCalledWith(profileFixture.roots);
    expect(result).toMatchObject({ ok: false, error: 'roots: root "/mnt/datalake/test": Path not found' });
    const run = db._collections.janitor_runs.docs[0];
    expect(run).toMatchObject({ status: 'failed', error: result.error, scan_id: null, proposed_actions: [] });
    expect(run.finished_at).toBeInstanceOf(Date);
    expect(scannerMod._instances).toHaveLength(0);
    expect(dedupScanner.buildDedupReport).not.toHaveBeenCalled();
    // The concurrency guard is released: the next run is not "already running".
    janitorProfiles.checkRoots.mockResolvedValue({ ok: true });
    dedupScanner.buildDedupReport.mockResolvedValue({ groups: [], summary: {} });
    dedupScanner.saveReport.mockResolvedValue(new ObjectId());
    expect((await janitorRunner.runProfile(db, String(profileFixture._id))).ok).toBe(true);
  });

  test('scanner failure marks run as failed', async () => {
    janitorProfiles.get.mockResolvedValue(profileFixture);
    // Override mock to throw on run
    const realScanner = scannerMod.Scanner;
    scannerMod.Scanner = class FailScanner extends EventEmitter {
      constructor() { super(); }
      async run() { throw new Error('disk on fire'); }
    };

    const db = makeMockDb();
    const result = await janitorRunner.runProfile(db, String(profileFixture._id));

    expect(result.ok).toBe(false);
    const run = db._collections['janitor_runs'].docs[0];
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/disk on fire/);

    scannerMod.Scanner = realScanner;
  });
});

describe('janitorRunner profile action preview/apply safety', () => {
  test('rotates an exact duplicate action around the operator-selected survivor before preview', async () => {
    const db = makeMockDb();
    const { runId } = seedPendingAction(db);
    janitorApprovalEvidence.verifyDuplicateAction.mockResolvedValueOnce({
      ok: true,
      proof: 'complete-sha256-all-members',
      sha256: DUPLICATE_SHA256,
      verified_at: new Date('2026-07-18T12:00:00.000Z'),
      survivor: {
        file: '/mnt/datalake/dup.txt', real_path: '/mnt/datalake/dup.txt',
        size: 100, mtime_ms: 1000, sha256: DUPLICATE_SHA256
      },
      targets: [{
        file: '/mnt/datalake/keep.txt', real_path: '/mnt/datalake/keep.txt',
        size: 100, mtime_ms: 900, sha256: DUPLICATE_SHA256
      }]
    });
    jest.spyOn(janitorService, 'executeCleanup').mockResolvedValue(previewResult('/mnt/datalake/keep.txt'));

    const result = await janitorRunner.approveAction(db, String(runId), 0, {
      confirm: true,
      dryRun: true,
      keepPath: '/mnt/datalake/dup.txt'
    });

    expect(result.ok).toBe(true);
    expect(result.action).toMatchObject({
      keep: { path: '/mnt/datalake/dup.txt' },
      files: ['/mnt/datalake/keep.txt'],
      survivorRule: 'operator_selected',
      execution_authorized: false,
      approval_preview: {
        restore_source: { file: '/mnt/datalake/dup.txt' },
        targets: [{ file: '/mnt/datalake/keep.txt' }]
      }
    });
    expect(janitorApprovalEvidence.verifyDuplicateAction).toHaveBeenCalledWith(
      expect.objectContaining({
        keep: { path: '/mnt/datalake/dup.txt' },
        files: ['/mnt/datalake/keep.txt']
      })
    );
  });

  test('rejects a survivor choice outside the exact duplicate group before hashing', async () => {
    const db = makeMockDb();
    const { runId } = seedPendingAction(db);

    const result = await janitorRunner.approveAction(db, String(runId), 0, {
      confirm: true,
      dryRun: true,
      keepPath: '/mnt/datalake/not-in-group.txt'
    });

    expect(result).toMatchObject({ ok: false, badRequest: true });
    expect(result.error).toMatch(/not a member/i);
    expect(janitorApprovalEvidence.verifyDuplicateAction).not.toHaveBeenCalled();
  });

  test('does not persist a preview when complete duplicate evidence fails', async () => {
    const db = makeMockDb();
    const { runId } = seedPendingAction(db);
    janitorApprovalEvidence.verifyDuplicateAction.mockResolvedValueOnce({
      ok: false,
      error: 'survivor changed during complete SHA-256 verification'
    });
    const execute = jest.spyOn(janitorService, 'executeCleanup');

    const result = await janitorRunner.approveAction(db, String(runId), 0, {
      confirm: true,
      dryRun: true
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/survivor changed/i);
    expect(execute).not.toHaveBeenCalled();
    expect(db._collections[janitorRunner.COLLECTION].docs[0].proposed_actions[0].approval_preview)
      .toBeUndefined();
  });

  test('persists an expiring exact-target dry-run preview without authorizing execution', async () => {
    const db = makeMockDb();
    const { runId } = seedPendingAction(db);
    const execute = jest.spyOn(janitorService, 'executeCleanup').mockResolvedValue(previewResult());

    const result = await janitorRunner.approveAction(db, String(runId), 0, {
      confirm: true,
      dryRun: true
    });

    expect(result.ok).toBe(true);
    expect(result.preview).toBe(true);
    expect(result.action.status).toBe('pending');
    expect(result.action.execution_authorized).toBe(false);
    expect(result.action.approval_preview).toMatchObject({
      status: 'ready',
      live_apply_available: false,
      target_digest: janitorService.generateCleanupDigest(['/mnt/datalake/dup.txt']),
      duplicate_proof: 'complete-sha256-all-members',
      sha256: DUPLICATE_SHA256,
      restore_source: {
        file: '/mnt/datalake/keep.txt',
        sha256: DUPLICATE_SHA256,
        verified_at: new Date('2026-07-18T12:00:00.000Z')
      }
    });
    expect(result.action.approval_preview.evidence_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.action.approval_preview.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(result.action.approval_preview.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(db._collections[janitorRunner.COLLECTION].docs[0].proposed_actions[0].approval_preview.id)
      .toBe(result.action.approval_preview.id);
    expect(execute).toHaveBeenCalledWith(
      ['/mnt/datalake/dup.txt'], expect.any(String), true, expect.objectContaining({
        atomicPreflight: true,
        expectedTargets: expect.any(Array),
        requiredEvidenceTargets: [expect.objectContaining({ file: '/mnt/datalake/keep.txt' })]
      })
    );
  });

  test('rejects direct apply, wrong, expired, and changed-target previews without live cleanup', async () => {
    process.env.JANITOR_EXECUTION_ENABLED = 'true';
    const db = makeMockDb();
    const { runId } = seedPendingAction(db);
    const execute = jest.spyOn(janitorService, 'executeCleanup').mockResolvedValue(previewResult());

    const direct = await janitorRunner.approveAction(db, String(runId), 0, {
      confirm: true,
      dryRun: false,
      previewId: 'not-recorded',
      applyConfirmation: janitorRunner.PROFILE_APPLY_CONFIRMATION,
      restoreConfirmation: janitorRunner.RESTORE_SOURCE_CONFIRMATION
    });
    expect(direct.ok).toBe(false);
    expect(direct.error).toMatch(/recorded dry-run preview/i);

    const recorded = await janitorRunner.approveAction(db, String(runId), 0, {
      confirm: true,
      dryRun: true
    });
    const previewId = recorded.action.approval_preview.id;
    const missingRestoreConfirmation = await janitorRunner.approveAction(db, String(runId), 0, {
      confirm: true,
      dryRun: false,
      previewId,
      applyConfirmation: janitorRunner.PROFILE_APPLY_CONFIRMATION
    });
    expect(missingRestoreConfirmation.badRequest).toBe(true);
    expect(missingRestoreConfirmation.error).toMatch(/restore_confirm/i);

    const wrong = await janitorRunner.approveAction(db, String(runId), 0, {
      confirm: true,
      dryRun: false,
      previewId: 'wrong-preview',
      applyConfirmation: janitorRunner.PROFILE_APPLY_CONFIRMATION,
      restoreConfirmation: janitorRunner.RESTORE_SOURCE_CONFIRMATION
    });
    expect(wrong.error).toMatch(/does not match/i);

    const stored = db._collections[janitorRunner.COLLECTION].docs[0].proposed_actions[0];
    stored.approval_preview.expires_at = new Date(Date.now() - 1);
    const expired = await janitorRunner.approveAction(db, String(runId), 0, {
      confirm: true,
      dryRun: false,
      previewId,
      applyConfirmation: janitorRunner.PROFILE_APPLY_CONFIRMATION,
      restoreConfirmation: janitorRunner.RESTORE_SOURCE_CONFIRMATION
    });
    expect(expired.error).toMatch(/expired/i);

    stored.approval_preview.expires_at = new Date(Date.now() + 60000);
    stored.files.push('/mnt/datalake/changed.txt');
    stored.candidatesToRemove.push({ path: '/mnt/datalake/changed.txt' });
    const changed = await janitorRunner.approveAction(db, String(runId), 0, {
      confirm: true,
      dryRun: false,
      previewId,
      applyConfirmation: janitorRunner.PROFILE_APPLY_CONFIRMATION,
      restoreConfirmation: janitorRunner.RESTORE_SOURCE_CONFIRMATION
    });
    expect(changed.error).toMatch(/targets changed/i);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('keeps live apply fail-closed when execution is not commissioned', async () => {
    delete process.env.JANITOR_EXECUTION_ENABLED;
    const db = makeMockDb();
    const { runId } = seedPendingAction(db);
    const execute = jest.spyOn(janitorService, 'executeCleanup').mockResolvedValue(previewResult());
    const recorded = await janitorRunner.approveAction(db, String(runId), 0, {
      confirm: true,
      dryRun: true
    });

    const apply = await janitorRunner.approveAction(db, String(runId), 0, {
      confirm: true,
      dryRun: false,
      previewId: recorded.action.approval_preview.id,
      applyConfirmation: janitorRunner.PROFILE_APPLY_CONFIRMATION,
      restoreConfirmation: janitorRunner.RESTORE_SOURCE_CONFIRMATION
    });

    expect(apply.ok).toBe(false);
    expect(apply.notCommissioned).toBe(true);
    expect(apply.error).toMatch(/not commissioned/i);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('rejects a preview whose restore-source evidence changed after recording', async () => {
    process.env.JANITOR_EXECUTION_ENABLED = 'true';
    const db = makeMockDb();
    const { runId } = seedPendingAction(db);
    const execute = jest.spyOn(janitorService, 'executeCleanup').mockResolvedValue(previewResult());
    const recorded = await janitorRunner.approveAction(db, String(runId), 0, {
      confirm: true,
      dryRun: true
    });
    const stored = db._collections[janitorRunner.COLLECTION].docs[0].proposed_actions[0];
    stored.approval_preview.restore_source.size += 1;

    const apply = await janitorRunner.approveAction(db, String(runId), 0, {
      confirm: true,
      dryRun: false,
      previewId: recorded.action.approval_preview.id,
      applyConfirmation: janitorRunner.PROFILE_APPLY_CONFIRMATION,
      restoreConfirmation: janitorRunner.RESTORE_SOURCE_CONFIRMATION
    });

    expect(apply.ok).toBe(false);
    expect(apply.error).toMatch(/preview evidence changed/i);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('invalidates the preview with zero deletions when the restore source changes', async () => {
    process.env.JANITOR_EXECUTION_ENABLED = 'true';
    const db = makeMockDb();
    const { runId } = seedPendingAction(db);
    jest.spyOn(janitorService, 'executeCleanup')
      .mockResolvedValueOnce(previewResult())
      .mockResolvedValueOnce({
        ok: false,
        preflight_failed: true,
        error: 'Cleanup preflight failed; no files were deleted',
        deleted: [],
        skipped: [],
        failed: [{
          file: '/mnt/datalake/keep.txt',
          reason: 'Restore source changed since recorded preview'
        }],
        space_freed: 0
      });
    const recorded = await janitorRunner.approveAction(db, String(runId), 0, {
      confirm: true,
      dryRun: true
    });

    const applied = await janitorRunner.approveAction(db, String(runId), 0, {
      confirm: true,
      dryRun: false,
      previewId: recorded.action.approval_preview.id,
      applyConfirmation: janitorRunner.PROFILE_APPLY_CONFIRMATION,
      restoreConfirmation: janitorRunner.RESTORE_SOURCE_CONFIRMATION
    });

    expect(applied.ok).toBe(true);
    expect(applied.executionFailed).toBe(true);
    expect(applied.action).toMatchObject({
      status: 'pending',
      execution_authorized: false,
      restore_source_confirmation: janitorRunner.RESTORE_SOURCE_CONFIRMATION,
      approval_preview: { status: 'invalidated' },
      result: {
        deleted: [],
        failed: [{ reason: 'Restore source changed since recorded preview' }]
      }
    });
  });

  test('atomically claims one apply, consumes its preview, and rejects replay', async () => {
    process.env.JANITOR_EXECUTION_ENABLED = 'true';
    const db = makeMockDb();
    const { runId } = seedPendingAction(db);
    const execute = jest.spyOn(janitorService, 'executeCleanup')
      .mockResolvedValueOnce(previewResult())
      .mockResolvedValueOnce({
        ok: true,
        dry_run: false,
        total_files: 1,
        deleted: [{ file: '/mnt/datalake/dup.txt', action: 'deleted', size: 100 }],
        skipped: [],
        failed: [],
        space_freed: 100
      });
    const recorded = await janitorRunner.approveAction(db, String(runId), 0, {
      confirm: true,
      dryRun: true
    });
    const previewId = recorded.action.approval_preview.id;

    const collection = db._collections[janitorRunner.COLLECTION];
    const originalFindOne = collection.findOne.getMockImplementation();
    const pendingSnapshot = cloneRun(collection.docs[0]);
    let pendingReads = 2;
    collection.findOne.mockImplementation(async filter => {
      if (pendingReads > 0) {
        pendingReads -= 1;
        return cloneRun(pendingSnapshot);
      }
      return originalFindOne(filter);
    });
    const options = {
      confirm: true,
      dryRun: false,
      previewId,
      applyConfirmation: janitorRunner.PROFILE_APPLY_CONFIRMATION,
      restoreConfirmation: janitorRunner.RESTORE_SOURCE_CONFIRMATION
    };
    const attempts = await Promise.all([
      janitorRunner.approveAction(db, String(runId), 0, options),
      janitorRunner.approveAction(db, String(runId), 0, options)
    ]);

    expect(attempts.filter(result => result.ok)).toHaveLength(1);
    expect(attempts.filter(result => !result.ok)).toHaveLength(1);
    expect(attempts.find(result => result.ok).action).toMatchObject({
      status: 'executed',
      execution_authorized: true,
      approval_preview: { status: 'consumed', id: previewId }
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(
      ['/mnt/datalake/dup.txt'], expect.any(String), false,
      expect.objectContaining({
        atomicPreflight: true,
        expectedTargets: expect.any(Array),
        requiredEvidenceTargets: [expect.objectContaining({ file: '/mnt/datalake/keep.txt' })]
      })
    );

    const replay = await janitorRunner.approveAction(db, String(runId), 0, options);
    expect(replay.ok).toBe(false);
    expect(replay.error).toMatch(/action is executed/i);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('janitorRunner.sweepStaleRuns', () => {
  // The sweep reads with find() and an array-field filter the shared mock does not model.
  function sweepDb(docs) {
    const db = makeMockDb();
    const coll = db.collection(janitorRunner.COLLECTION);
    coll.docs.push(...docs);
    coll.updateMany = jest.fn(async (filter, update) => {
      const hit = coll.docs.filter(doc => matches(doc, filter));
      hit.forEach(doc => Object.entries(update.$set).forEach(([key, value]) => setPath(doc, key, value)));
      return { modifiedCount: hit.length };
    });
    coll.find = jest.fn((filter) => ({
      toArray: async () => coll.docs
        .filter(doc => (doc.proposed_actions || []).some(action => action.status === filter['proposed_actions.status']))
        .map(cloneRun)
    }));
    return { db, coll };
  }

  test('stops runs left running and leaves finished runs alone', async () => {
    const { db, coll } = sweepDb([
      { _id: new ObjectId(), status: 'running', finished_at: null, proposed_actions: [] },
      { _id: new ObjectId(), status: 'complete', finished_at: new Date(0), proposed_actions: [] }
    ]);

    await expect(janitorRunner.sweepStaleRuns(db)).resolves.toBe(1);

    expect(coll.docs[0].status).toBe('stopped');
    expect(coll.docs[0].finished_at).toBeInstanceOf(Date);
    expect(coll.docs[1]).toMatchObject({ status: 'complete', finished_at: new Date(0) });
  });

  test('returns an action stuck in executing to pending with its preview invalidated, without executing anything', async () => {
    const executeCleanup = jest.spyOn(janitorService, 'executeCleanup');
    const startedAt = new Date('2026-07-18T12:00:00.000Z');
    const { db, coll } = sweepDb([{
      _id: new ObjectId(),
      status: 'complete',
      proposed_actions: [
        { status: 'executed', files: ['/mnt/datalake/a.txt'], approval_preview: { id: 'p0', status: 'consumed' } },
        {
          status: 'executing', files: ['/mnt/datalake/dup.txt'], execution_authorized: true,
          execution_started_at: startedAt, approval_preview: { id: 'p1', status: 'ready' }
        },
        { status: 'pending', files: ['/mnt/datalake/b.txt'], approval_preview: { id: 'p2', status: 'ready' } }
      ]
    }]);

    await janitorRunner.sweepStaleRuns(db);

    const [executed, interrupted, pending] = coll.docs[0].proposed_actions;
    expect(interrupted).toMatchObject({
      status: 'pending',
      execution_authorized: false,
      execution_started_at: startedAt,
      approval_preview: { id: 'p1', status: 'invalidated' },
      result: { note: expect.stringMatching(/interrupted by a restart.*Generate a new preview/) }
    });
    expect(interrupted.execution_interrupted_at).toBeInstanceOf(Date);
    expect(interrupted.approval_preview.invalidated_at).toBeInstanceOf(Date);
    expect(executed).toEqual({ status: 'executed', files: ['/mnt/datalake/a.txt'], approval_preview: { id: 'p0', status: 'consumed' } });
    expect(pending.approval_preview.status).toBe('ready');
    expect(executeCleanup).not.toHaveBeenCalled();
  });

  test('a swept action cannot be applied with its old preview', async () => {
    process.env.JANITOR_EXECUTION_ENABLED = 'true';
    const executeCleanup = jest.spyOn(janitorService, 'executeCleanup');
    const runId = new ObjectId();
    const { db } = sweepDb([{
      _id: runId,
      status: 'complete',
      proposed_actions: [{
        status: 'executing', files: ['/mnt/datalake/dup.txt'],
        approval_preview: { id: 'p1', status: 'ready', expires_at: new Date(Date.now() + 60000) }
      }]
    }]);
    await janitorRunner.sweepStaleRuns(db);

    const result = await janitorRunner.approveAction(db, String(runId), 0, {
      confirm: true, dryRun: false, previewId: 'p1',
      applyConfirmation: janitorRunner.PROFILE_APPLY_CONFIRMATION,
      restoreConfirmation: janitorRunner.RESTORE_SOURCE_CONFIRMATION
    });

    expect(result).toMatchObject({ ok: false, error: 'a recorded dry-run preview is required before live apply' });
    expect(executeCleanup).not.toHaveBeenCalled();
  });
});
