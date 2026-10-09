/**
 * Integration test (REAL MongoDB) for stored duplicate-review decisions: the
 * HTTP routes, staleness against the file index, the paged read of the report's
 * groups, the report annotation, and the proof that a decision is intent only.
 *
 * Synthetic paths and hashes. No scan runs and no file is touched: the only
 * approval calls made here are refused before they reach the filesystem.
 */
const express = require('express');
const request = require('supertest');
const { MongoClient, ObjectId } = require('mongodb');
const janitorRunner = require('../../services/janitorRunner');
const janitorService = require('../../services/janitorService');
const janitorStrategy = require('../../services/janitorStrategy');
const reviewDecisions = require('../../services/janitorReviewDecisions');
const routes = require('../../routes/janitor-profiles.routes');

const URI = process.env.MONGODB_URI_TEST;
const TEST_DB = URI ? new URL(URI).pathname.slice(1) : '';
if (!URI || !TEST_DB.startsWith('agentx_data_test_')) throw new Error('Run the Data test launcher with its disposable MongoDB.');

const BASE = '/api/v1/janitor/profiles/shared-drive';
const sha = (n) => n.toString(16).padStart(64, '0');
const SHA = sha(1);
const A = '/mnt/datalake/example/a.bin';
const B = '/mnt/datalake/example/copy/a.bin';
const C = '/mnt/media/example/a.bin';
const file = (path, sha256, size = 1000, mtime = 50) => ({ path, sha256, size, mtime, hash_fingerprint: `${size}:${mtime}`, storage_role: null });
const body = (overrides = {}) => ({ decision: 'dedupe', survivorPath: A, evidence: { size: 1000, paths: [A, B] }, ...overrides });

describe('janitor review decisions (integration, real Mongo)', () => {
  let client;
  let db;
  let app;

  beforeAll(async () => {
    client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 });
    await client.connect();
    db = client.db(TEST_DB);
    app = express();
    app.use(express.json({ limit: '2mb' }));
    app.locals.db = db;
    app.use('/api/v1/janitor/profiles', routes);
  });

  const collections = ['nas_files', 'nas_scans', reviewDecisions.COLLECTION, janitorRunner.COLLECTION,
    janitorStrategy.REPORT_COLLECTION, janitorStrategy.REPORT_DETAIL_COLLECTION, janitorStrategy.POLICY_COLLECTION];
  const wipe = () => Promise.all(collections.map((name) => db.collection(name).deleteMany({})));
  beforeEach(wipe);
  afterAll(async () => {
    if (db) { try { await wipe(); } catch { /* best-effort cleanup */ } }
    if (client) await client.close();
  });

  const list = async (query = '') => (await request(app).get(`${BASE}/review-decisions${query}`).expect(200)).body.data;

  test('one decision per content hash: stored, replaced, listed, undone', async () => {
    await db.collection('nas_files').insertMany([file(A, SHA), file(B, SHA)]);
    const created = await request(app).put(`${BASE}/review-decisions/${SHA}`).send(body({ note: ' first ' })).expect(201);
    expect(created.body.data.decision).toMatchObject({
      sha256: SHA, decision: 'dedupe', survivorPath: A, note: 'first', source: 'toolbox',
      evidence: { size: 1000, paths: [A, B] }, authorizesFilesystemMutation: false
    });
    // The same hash again replaces the decision instead of adding a second one.
    const replaced = await request(app).put(`${BASE}/review-decisions/${SHA}`).send({ decision: 'keep_all', evidence: { size: 1000, paths: [B, A] } }).expect(200);
    expect(replaced.body.data.created).toBe(false);
    expect(await db.collection(reviewDecisions.COLLECTION).countDocuments({})).toBe(1);

    const listed = await list();
    expect(listed.decisions).toHaveLength(1);
    expect(listed.decisions[0]).toMatchObject({ sha256: SHA, decision: 'keep_all', survivorPath: null, state: 'current', staleReasons: [] });
    expect(listed.summary).toMatchObject({ total: 1, byDecision: { keep_all: 1, dedupe: 0, defer: 0 }, current: 1, stale: 0, reference: 'file-index' });

    await request(app).delete(`${BASE}/review-decisions/${SHA}`).expect(200);
    await request(app).delete(`${BASE}/review-decisions/${SHA}`).expect(404);
    expect((await list()).decisions).toEqual([]);
  });

  test('invalid writes are refused and store nothing', async () => {
    const refused = [
      [`${SHA}`, body({ survivorPath: C })],
      [`${SHA}`, body({ evidence: { size: 1000, paths: [A, '/etc/passwd'] } })],
      [`${SHA}`, body({ approve: true })],
      [`${SHA}`, body({ evidence: { size: 2 ** 60, paths: [A, B] } })],
      ['not-a-hash', body()],
      [`${SHA}`, { $set: { decision: 'dedupe' } }]
    ];
    for (const [id, payload] of refused) {
      const res = await request(app).put(`${BASE}/review-decisions/${id}`).send(payload).expect(400);
      expect(res.body.errors.length).toBeGreaterThan(0);
    }
    await request(app).delete(`${BASE}/review-decisions/not-a-hash`).expect(400);
    await request(app).get(`${BASE}/review-decisions?limit=201`).expect(400);
    await request(app).get(`${BASE}/review-decisions?pathPrefix=/etc`).expect(400);
    expect(await db.collection(reviewDecisions.COLLECTION).countDocuments({})).toBe(0);
  });

  test('a batch is bounded, all-or-nothing, and insert_missing never replaces a stored decision', async () => {
    const entry = (n, extra = {}) => ({ sha256: sha(n), ...body(), ...extra });
    await request(app).post(`${BASE}/review-decisions/batch`).send({ decisions: Array.from({ length: 201 }, (_, i) => entry(i + 1)) }).expect(400);
    await request(app).post(`${BASE}/review-decisions/batch`).send({ decisions: [entry(1), entry(2, { decision: 'delete' })] }).expect(400);
    expect(await db.collection(reviewDecisions.COLLECTION).countDocuments({})).toBe(0);

    await request(app).put(`${BASE}/review-decisions/${sha(1)}`).send(body({ decision: 'keep_all', survivorPath: undefined })).expect(201);
    const imported = await request(app).post(`${BASE}/review-decisions/batch`)
      .send({ mode: 'insert_missing', decisions: [entry(1, { source: 'browser-draft-import' }), entry(2, { source: 'browser-draft-import' })] }).expect(200);
    expect(imported.body.data).toMatchObject({ mode: 'insert_missing', saved: [sha(2)], skipped: [sha(1)], created: 1 });
    expect((await db.collection(reviewDecisions.COLLECTION).findOne({ _id: sha(1) })).decision).toBe('keep_all');
    expect((await db.collection(reviewDecisions.COLLECTION).findOne({ _id: sha(2) })).source).toBe('browser-draft-import');

    const replaced = await request(app).post(`${BASE}/review-decisions/batch`).send({ decisions: [entry(1, { decision: 'defer', survivorPath: undefined })] }).expect(200);
    expect(replaced.body.data).toMatchObject({ mode: 'upsert', saved: [sha(1)], skipped: [] });
    expect((await db.collection(reviewDecisions.COLLECTION).findOne({ _id: sha(1) })).decision).toBe('defer');

    const full = await request(app).post(`${BASE}/review-decisions/batch`).send({ decisions: Array.from({ length: 200 }, (_, i) => entry(i + 10)) }).expect(200);
    expect(full.body.data.saved).toHaveLength(200);
  });

  test('staleness is computed against the index and never applied silently', async () => {
    const files = db.collection('nas_files');
    await files.insertMany([file(A, SHA), file(B, SHA)]);
    await request(app).put(`${BASE}/review-decisions/${SHA}`).send(body()).expect(201);
    const state = async () => (await list()).decisions[0];
    const codes = (decision) => decision.staleReasons.map((reason) => reason.code);
    expect(await state()).toMatchObject({ state: 'current' });

    // A new copy appeared.
    await files.insertOne(file(C, SHA));
    expect(codes(await state())).toEqual(['new_copies']);
    await files.deleteOne({ path: C });

    // A copy changed content: same path, other hash.
    await files.updateOne({ path: B }, { $set: { sha256: sha(99) } });
    expect(codes(await state())).toEqual(['group_not_verified', 'hash_changed']);

    // Its hash is no longer current for the file's size and date.
    await files.updateOne({ path: B }, { $set: { sha256: SHA, mtime: 51 } });
    expect(codes(await state())).toEqual(['group_not_verified', 'hash_changed']);
    await files.updateOne({ path: B }, { $set: { mtime: 50 } });
    expect((await state()).state).toBe('current');

    // The survivor is gone and another copy took its place.
    await files.deleteOne({ path: A });
    await files.insertOne(file(C, SHA));
    const stale = await state();
    expect(codes(stale)).toEqual(['path_missing', 'new_copies', 'survivor_missing']);
    // The stored decision is untouched: stale is reported, nothing is rewritten.
    expect(stale).toMatchObject({ decision: 'dedupe', survivorPath: A, evidence: { paths: [A, B] } });

    // A copy outside the shared roots, or in a key store, is not a member.
    await files.deleteMany({});
    await files.insertMany([file(A, SHA), file(B, SHA), file('/srv/other/a.bin', SHA), file('/mnt/datalake/keys/a.bin', SHA)]);
    expect((await state()).state).toBe('current');

    const summary = (await list()).summary;
    expect(summary).toMatchObject({ current: 1, stale: 0, dedupe: { current: 1, reclaimableBytes: 1000 } });
    await files.insertOne(file(C, SHA));
    const after = (await list('?state=stale'));
    expect(after.decisions.map((decision) => decision.sha256)).toEqual([SHA]);
    // A stale dedupe decision no longer counts as reclaimable space.
    expect(after.summary).toMatchObject({ stale: 1, staleByReason: { new_copies: 1 }, dedupe: { current: 0, stale: 1, reclaimableBytes: 0 } });
    expect((await list('?state=current')).decisions).toEqual([]);
  });

  test('lists filter by decision, path prefix and hash, with bounded pages', async () => {
    const media = ['/mnt/media/films/x.mkv', '/mnt/media/films/copy/x.mkv'];
    await request(app).put(`${BASE}/review-decisions/${sha(1)}`).send(body()).expect(201);
    await request(app).put(`${BASE}/review-decisions/${sha(2)}`).send({ decision: 'keep_all', evidence: { size: 5, paths: media } }).expect(201);
    await request(app).put(`${BASE}/review-decisions/${sha(3)}`).send({ decision: 'defer', evidence: { size: 5, paths: ['/mnt/media/filmsX/y', '/mnt/media/filmsX/z'] } }).expect(201);
    const ids = (data) => data.decisions.map((decision) => decision.sha256).sort();
    expect(ids(await list('?decision=keep_all'))).toEqual([sha(2)]);
    expect(ids(await list('?pathPrefix=/mnt/media'))).toEqual([sha(2), sha(3)]);
    // A prefix matches whole path segments, not look-alike folders.
    expect(ids(await list('?pathPrefix=/mnt/media/films'))).toEqual([sha(2)]);
    expect(ids(await list(`?sha256=${sha(1)},${sha(3)},${sha(9)}`))).toEqual([sha(1), sha(3)]);
    const page = await list('?limit=2&offset=2');
    expect(page.decisions).toHaveLength(1);
    expect(page.pagination).toMatchObject({ total: 3, offset: 2, limit: 2, complete: true });
    // The summary always covers every stored decision, whatever the filter.
    expect((await list('?decision=defer')).summary.byDecision).toEqual({ keep_all: 1, dedupe: 1, defer: 1 });
  });

  async function storeReport(count, policy = { duplicateSurvivor: 'canonical_active', backupRetention: 'staging', generatedCache: 'review_rebuildable' }) {
    const groups = Array.from({ length: count }, (_, index) => ({
      sha256: sha(index + 1), proof: 'sha256-current-metadata', size: 1000, count: 2, provenSavingsBytes: 1000,
      files: index === 0
        ? [{ path: B, mtime: 1, storageRole: null }, { path: A, mtime: 2, storageRole: null }]
        : [{ path: `/mnt/media/g${index}/a`, mtime: 1, storageRole: null }, { path: `/mnt/media/g${index}/copy/a`, mtime: 2, storageRole: null }]
    }));
    const id = await janitorStrategy.persistStrategyReport(db, {
      generatedAt: new Date(), status: 'ready_for_review', policy,
      evidence: { verifiedDuplicateGroups: count, verifiedDuplicateEvidence: groups }, maintenance: { proposals: [] }
    });
    return { id, groups };
  }

  test('the report groups are read in bounded pages, across chunk boundaries', async () => {
    await request(app).get(`${BASE}/strategy/latest/groups`).expect(404);
    const { id } = await storeReport(250);
    expect(await db.collection(janitorStrategy.REPORT_DETAIL_COLLECTION).countDocuments({ reportId: id })).toBe(3);
    const page = async (query = '') => (await request(app).get(`${BASE}/strategy/latest/groups${query}`).expect(200)).body.data;

    const first = await page();
    expect(first).toMatchObject({ total: 250, offset: 0, limit: 30, nextOffset: 30, review: 'all', report: { id: String(id), duplicateSurvivorRule: 'canonical_active' } });
    expect(first.groups).toHaveLength(30);
    expect(first.groups[0]).toMatchObject({ sha256: sha(1), position: 0, review: null, policySurvivorPath: A });

    // A page that starts in one chunk and ends in the next.
    const across = await page('?offset=90&limit=20');
    expect(across.groups.map((group) => group.position)).toEqual(Array.from({ length: 20 }, (_, index) => 90 + index));
    expect(across.nextOffset).toBe(110);

    const last = await page('?offset=240&limit=50');
    expect(last.groups).toHaveLength(10);
    expect(last.nextOffset).toBeNull();
    expect((await page('?offset=9999')).groups).toEqual([]);

    await request(app).get(`${BASE}/strategy/latest/groups?limit=51`).expect(400);
    await request(app).get(`${BASE}/strategy/latest/groups?limit=all`).expect(400);
    await request(app).get(`${BASE}/strategy/latest/groups?review=decided`).expect(400);
  });

  test('pages mark each group with its decision and can skip the decided ones', async () => {
    await storeReport(250);
    const page = async (query = '') => (await request(app).get(`${BASE}/strategy/latest/groups${query}`).expect(200)).body.data;
    // Group 1: the owner keeps B where the policy would keep A.
    await request(app).put(`${BASE}/review-decisions/${sha(1)}`).send(body({ survivorPath: B })).expect(201);
    // Group 2: decided on a shape the report no longer shows.
    await request(app).put(`${BASE}/review-decisions/${sha(2)}`).send({ decision: 'keep_all', evidence: { size: 1000, paths: ['/mnt/media/g1/a', '/mnt/media/g1/old/a'] } }).expect(201);

    const marked = (await page('?limit=3')).groups;
    expect(marked[0].review).toMatchObject({
      decision: 'dedupe', state: 'current', survivorPath: B, policySurvivorPath: A, survivorDiffersFromPolicy: true,
      reference: 'report-group', authorizesFilesystemMutation: false
    });
    expect(marked[1].review).toMatchObject({ decision: 'keep_all', state: 'stale' });
    expect(marked[1].review.staleReasons.map((reason) => reason.code)).toEqual(['path_missing', 'new_copies']);
    expect(marked[2].review).toBeNull();

    // Named groups are found wherever they sit in the report, marked the same way.
    const named = await page(`?sha256=${sha(240)},${sha(1)},${sha(9999)}`);
    expect(named.groups.map((group) => group.sha256).sort()).toEqual([sha(1), sha(240)]);
    expect(named.groups.find((group) => group.sha256 === sha(1)).review.decision).toBe('dedupe');
    expect(named).toMatchObject({ lookup: 'sha256', total: 250, nextOffset: null });

    const undecided = await page('?review=undecided&limit=5');
    expect(undecided.groups.map((group) => group.position)).toEqual([2, 3, 4, 5, 6]);
    expect(undecided).toMatchObject({ nextOffset: 7, scanned: 7, scanBoundReached: false });
  });

  test('the full report is annotated on the way out and its stored groups are not rewritten', async () => {
    const { id } = await storeReport(3);
    await request(app).put(`${BASE}/review-decisions/${sha(1)}`).send(body()).expect(201);
    await request(app).put(`${BASE}/review-decisions/${sha(777)}`).send({ decision: 'defer', evidence: { size: 9, paths: ['/mnt/media/q/a', '/mnt/media/q/b'] } }).expect(201);
    const report = (await request(app).get(`${BASE}/strategy/latest`).expect(200)).body.data.report;
    expect(report.reviewDecisions).toMatchObject({
      reference: 'report-groups', total: 2, byDecision: { keep_all: 0, dedupe: 1, defer: 1 },
      current: 1, stale: 1, inReport: 1, notInReport: 1, authorizesFilesystemMutation: false,
      dedupe: { current: 1, reclaimableBytes: 1000, survivorDiffersFromPolicy: 0 }
    });
    expect(report.evidence.verifiedDuplicateEvidence[0].review).toMatchObject({ decision: 'dedupe', state: 'current' });
    expect(report.evidence.verifiedDuplicateEvidence[1].review).toBeUndefined();
    const chunks = await db.collection(janitorStrategy.REPORT_DETAIL_COLLECTION).find({ reportId: id }).toArray();
    expect(chunks.flatMap((chunk) => chunk.groups).some((group) => 'review' in group)).toBe(false);
  });

  test('a generated report counts the decisions without changing its groups or its proposals', async () => {
    await db.collection('nas_files').insertMany([file(A, SHA, 1000, 60), file(B, SHA, 1000, 50), file('/mnt/media/n/a', sha(2), 40), file('/mnt/media/n/b', sha(2), 40)]);
    await db.collection(janitorStrategy.POLICY_COLLECTION).insertOne({ _id: janitorStrategy.POLICY_ID, version: 1, duplicateSurvivor: 'newest', backupRetention: 'staging', generatedCache: 'review_rebuildable' });
    const without = (await janitorStrategy.generateStrategy(db, { persist: false })).report;
    expect(without.reviewDecisions).toMatchObject({ total: 0, dedupe: { reclaimableBytes: 0 } });

    // The owner keeps B; the policy ("newest") keeps A.
    await request(app).put(`${BASE}/review-decisions/${SHA}`).send(body({ survivorPath: B })).expect(201);
    const { report } = await janitorStrategy.generateStrategy(db, { persist: true });
    expect(report.reviewDecisions).toMatchObject({
      total: 1, byDecision: { keep_all: 0, dedupe: 1, defer: 0 }, current: 1, stale: 0,
      dedupe: { current: 1, reclaimableBytes: 1000, survivorDiffersFromPolicy: 1 }
    });
    const stored = await db.collection(janitorStrategy.REPORT_COLLECTION).findOne({ _id: report._id });
    expect(stored.reviewDecisions.dedupe.reclaimableBytes).toBe(1000);
    // Same verified groups, same policy survivors, same proposals.
    expect(report.evidence.verifiedDuplicateEvidence).toEqual(without.evidence.verifiedDuplicateEvidence);
    expect(report.maintenance.proposals).toEqual(without.maintenance.proposals);
    expect(report.maintenance.proposals.find((proposal) => proposal.sha256 === SHA).keep.path).toBe(A);
    expect(report.maintenance.executableActions).toEqual([]);

    const served = (await request(app).get(`${BASE}/strategy/latest`).expect(200)).body.data.report;
    const marked = served.evidence.verifiedDuplicateEvidence.find((group) => group.sha256 === SHA);
    expect(marked.review).toMatchObject({ survivorPath: B, policySurvivorPath: A, survivorDiffersFromPolicy: true });
    expect(served.reviewDecisions.atGeneration.total).toBe(1);
  });

  test('a stored dedupe decision changes no run action and cannot be used as a preview or a confirmation', async () => {
    const previousFlag = process.env.JANITOR_EXECUTION_ENABLED;
    process.env.JANITOR_EXECUTION_ENABLED = 'true';
    const execute = jest.spyOn(janitorService, 'executeCleanup');
    try {
      const runs = db.collection(janitorRunner.COLLECTION);
      const action = {
        type: 'delete_duplicates', sha256: SHA, keep: A, files: [B], space_saved: 1000,
        status: 'pending', approval_required: true, execution_authorized: false, approval_preview: null, executed_at: null, result: null
      };
      const { insertedId } = await runs.insertOne({ profile_id: new ObjectId(), status: 'complete', started_at: new Date(), proposed_actions: [action] });
      const before = await runs.findOne({ _id: insertedId });

      const saved = await request(app).put(`${BASE}/review-decisions/${SHA}`).send(body()).expect(201);
      await request(app).post(`${BASE}/review-decisions/batch`).send({ decisions: [{ sha256: sha(2), ...body() }] }).expect(200);
      expect(await runs.findOne({ _id: insertedId })).toEqual(before);

      // Everything a caller could take from a stored decision, offered as a preview id.
      const decision = saved.body.data.decision;
      const candidates = [SHA, decision.survivorPath, decision.decidedAt, 'dedupe', `review-decision:${SHA}`];
      for (const previewId of candidates) {
        const result = await janitorRunner.approveAction(db, String(insertedId), 0, {
          confirm: true, dryRun: false, previewId,
          applyConfirmation: janitorRunner.PROFILE_APPLY_CONFIRMATION,
          restoreConfirmation: janitorRunner.RESTORE_SOURCE_CONFIRMATION
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/recorded dry-run preview is required/);
      }
      // Over HTTP: the decision as a body confirms nothing, and a decision hash is no preview.
      const approve = `/api/v1/janitor/profiles/runs/${insertedId}/actions/0/approve`;
      await request(app).post(approve).send(decision).expect(400);
      await request(app).post(approve).send({ ...decision, confirm: true, dry_run: false }).expect(400);
      const refused = await request(app).post(approve).send({
        confirm: true, dry_run: false, preview_id: SHA,
        apply_confirm: janitorRunner.PROFILE_APPLY_CONFIRMATION, restore_confirm: janitorRunner.RESTORE_SOURCE_CONFIRMATION
      }).expect(409);
      expect(refused.body.message).toMatch(/recorded dry-run preview is required/);

      expect(execute).not.toHaveBeenCalled();
      expect(await runs.findOne({ _id: insertedId })).toEqual(before);
      // Undoing the decision leaves the run exactly as it was, too.
      await request(app).delete(`${BASE}/review-decisions/${SHA}`).expect(200);
      expect(await runs.findOne({ _id: insertedId })).toEqual(before);
    } finally {
      execute.mockRestore();
      if (previousFlag === undefined) delete process.env.JANITOR_EXECUTION_ENABLED;
      else process.env.JANITOR_EXECUTION_ENABLED = previousFlag;
    }
  });
});
