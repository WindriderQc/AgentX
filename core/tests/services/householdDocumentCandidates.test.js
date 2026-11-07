'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const Candidate = require('../../models/HouseholdDocumentCandidate');
const { createDocumentArchive, MAX_BYTES } = require('../../src/services/householdDocumentArchive');
const { createDocumentCandidates } = require('../../src/services/householdDocumentCandidates');
const { registerDocumentCandidateRoutes, createKnowledgeTarget } = require('../../surfaces/household/document-candidate-routes');
const { sha256 } = require('../../src/helpers/fileContentChecks');
const familyDevice = require('../../surfaces/household/family-device');

let root, configPath, config, archive, service, rag, docs, target, now;
const notFound = () => Object.assign(new Error('missing'), { status: 404 });
const save = () => fs.writeFile(configPath, JSON.stringify(config));
const select = row => service.review(row.id, { expectedRevision: row.revision, decision: 'select', reviewer: 'Synthetic reviewer' });
const promote = (row, extra = {}) => service.promote(row.id, { expectedRevision: row.revision,
  requestId: randomUUID(), confirmation: `SHARE ${row.id}`, ...extra });
beforeEach(async () => {
  await Candidate.deleteMany({});
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'household-documents-'));
  configPath = path.join(root, 'candidates.json');
  config = { schemaVersion: 1, archiveId: 'synthetic-archive', root, documents: [{ id: 'manual',
    relativePath: 'manual.md', title: 'Synthetic manual', scope: 'owner', sensitivity: 'private',
    validFrom: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z',
    sourceRefs: [{ system: 'private-archive', id: 'synthetic-original' }], tags: ['manual'] }] };
  await save(); await fs.writeFile(path.join(root, 'manual.md'), '# Synthetic manual\n\nUntrusted reference text.');
  archive = createDocumentArchive({ configPath });
  docs = new Map(); now = new Date('2026-06-01T00:00:00Z');
  target = { source: 'synthetic-household', lanes: ['family', 'reader'], revision: 'synthetic-target-v1' };
  rag = { getDocument: jest.fn(async id => { if (!docs.has(id)) throw notFound(); return docs.get(id); }),
    upsertDocumentWithChunks: jest.fn(async (text, metadata) => {
      docs.set(metadata.documentId, { documentId: metadata.documentId, source: metadata.source, chunkCount: 1,
        metadata: { ...metadata, contentHash: sha256(Buffer.from(text)), mixedRevision: false, revisionFingerprint: 'a'.repeat(64) } });
      return { documentId: metadata.documentId, chunkCount: 1 };
    }) };
  service = createDocumentCandidates({ archive, rag, targetSource: () => target, now: () => now });
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

test('stages an immutable private snapshot with provenance; replay does not index or change the original', async () => {
  const original = await fs.readFile(path.join(root, 'manual.md'));
  const before = await fs.stat(path.join(root, 'manual.md'));
  const first = await service.stage({ sourceId: 'manual' });
  expect(await service.stage({ sourceId: 'manual' })).toEqual(first);
  expect(await Candidate.countDocuments()).toBe(1);
  expect(first).toMatchObject({ state: 'staged', scope: 'owner', sensitivity: 'private', text: original.toString(),
    sourceRefs: [{ system: 'private-archive', id: 'synthetic-original' }], expiresAt: '2027-01-01T00:00:00.000Z' });
  expect((await archive.list()).entries[0]).not.toHaveProperty('relativePath');
  expect(JSON.stringify(await service.list())).not.toContain(root);
  expect(await fs.readFile(path.join(root, 'manual.md'))).toEqual(original);
  expect((await fs.stat(path.join(root, 'manual.md'))).mtimeMs).toBe(before.mtimeMs);
  expect(rag.upsertDocumentWithChunks).not.toHaveBeenCalled();
});

test('requires separate selection and exact sharing confirmation; the derivative keeps an opaque source link and expiry', async () => {
  let row = await service.stage({ sourceId: 'manual' });
  await expect(promote(row)).rejects.toMatchObject({ statusCode: 409 });
  row = await select(row);
  expect(row.selection).toMatchObject({ reviewer: 'Synthetic reviewer', identityVerified: false, target });
  await expect(promote(row, { confirmation: 'yes' })).rejects.toMatchObject({ statusCode: 400 });
  const requestId = randomUUID();
  const done = await promote(row, { requestId });
  expect(done).toMatchObject({ state: 'promoted', scope: 'owner', sensitivity: 'private',
    receipt: { documentId: `household-approved-${row.id}`, source: target.source, chunkCount: 1 } });
  expect(rag.upsertDocumentWithChunks).toHaveBeenCalledWith(row.text, expect.objectContaining({
    documentId: `household-approved-${row.id}`, source: target.source, scope: 'household', sensitivity: 'normal',
    invalidatedAt: '2027-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z',
    sourceRefs: [{ system: 'household-review', id: row.id }] }));
  expect(JSON.stringify(rag.upsertDocumentWithChunks.mock.calls)).not.toContain(root);
  expect((await promote(row, { requestId })).receipt).toEqual(done.receipt);
  await expect(promote(row)).rejects.toMatchObject({ statusCode: 409 });
  expect(rag.upsertDocumentWithChunks).toHaveBeenCalledTimes(1);
  expect(await fs.readFile(path.join(root, 'manual.md'), 'utf8')).toBe(row.text);
});

test.each(['content', 'labels', 'expiry', 'reference', 'removed'])('refuses promotion if the reviewed original changes: %s', async what => {
  const row = await select(await service.stage({ sourceId: 'manual' }));
  if (what === 'content') await fs.writeFile(path.join(root, 'manual.md'), 'Synthetic changed source');
  if (what === 'labels') config.documents[0].sensitivity = 'highly_private';
  if (what === 'expiry') config.documents[0].expiresAt = '2026-12-01T00:00:00Z';
  if (what === 'reference') config.documents[0].sourceRefs[0].id = 'changed';
  if (what === 'removed') await fs.unlink(path.join(root, 'manual.md'));
  await save();
  await expect(promote(row)).rejects.toMatchObject({ statusCode: 409 });
  expect(rag.upsertDocumentWithChunks).not.toHaveBeenCalled();
  expect((await service.get(row.id)).state).toBe('selected');
});

test('expired and superseded sources cannot be selected; expiry at dispatch and changed corpus both refuse', async () => {
  let row = await service.stage({ sourceId: 'manual' });
  now = new Date(row.expiresAt);
  await expect(select(row)).rejects.toMatchObject({ code: 'HOUSEHOLD_DOCUMENT_EXPIRED' });
  now = new Date('2026-06-01T00:00:00Z'); row = await select(row);
  now = new Date(row.expiresAt);
  await expect(promote(row)).rejects.toMatchObject({ code: 'HOUSEHOLD_DOCUMENT_EXPIRED' });
  now = new Date('2026-06-01T00:00:00Z'); target.revision = 'changed';
  await expect(promote(row)).rejects.toMatchObject({ code: 'HOUSEHOLD_DOCUMENT_TARGET_CHANGED' });
  target = null;
  await expect(select(row)).rejects.toMatchObject({ code: 'HOUSEHOLD_DOCUMENT_TARGET_DISABLED' });
  config.documents[0].invalidatedAt = '2026-07-01T00:00:00Z'; config.documents[0].supersededBy = 'synthetic-successor'; await save();
  await expect(select(await service.stage({ sourceId: 'manual' }))).rejects.toMatchObject({ code: 'HOUSEHOLD_DOCUMENT_EXPIRED' });
  expect(rag.upsertDocumentWithChunks).not.toHaveBeenCalled();
});

test('changing configured readers after selection requires selection again', async () => {
  const row = await select(await service.stage({ sourceId: 'manual' }));
  target.lanes.push('operator');
  await expect(promote(row)).rejects.toMatchObject({ code: 'HOUSEHOLD_DOCUMENT_TARGET_CHANGED' });
  expect(rag.upsertDocumentWithChunks).not.toHaveBeenCalled();
  expect((await promote(await select(row))).state).toBe('promoted');
});

test('the route target must match the active family reader, including its source and lanes', () => {
  const knowledgeConfig = { status: 'active', retrieval: { enabled: true },
    householdDocuments: { source: 'synthetic-family', lanes: ['family', 'reader'] } };
  const served = { config: structuredClone(knowledgeConfig) };
  const loaded = { config: knowledgeConfig };
  const readTarget = createKnowledgeTarget(served, () => loaded);
  expect(readTarget()).toMatchObject({ source: 'synthetic-family', lanes: ['family', 'reader'] });
  knowledgeConfig.householdDocuments.source = 'changed';
  expect(readTarget()).toBeNull();
  served.config = structuredClone(knowledgeConfig);
  expect(readTarget().source).toBe('changed');
  knowledgeConfig.householdDocuments.lanes = ['operator']; served.config = structuredClone(knowledgeConfig);
  expect(readTarget()).toBeNull();
  knowledgeConfig.householdDocuments.lanes = ['family']; knowledgeConfig.retrieval.enabled = false;
  expect(readTarget()).toBeNull();
  loaded.config = null; expect(readTarget()).toBeNull();
});

test('unknown fact dates remain unknown and the earliest validity deadline wins', async () => {
  delete config.documents[0].validFrom;
  config.documents[0].invalidatedAt = '2026-08-01T00:00:00Z'; await save();
  const row = await select(await service.stage({ sourceId: 'manual' }));
  expect((await promote(row)).target).toMatchObject({ validFrom: null, invalidatedAt: '2026-08-01T00:00:00.000Z' });
});

test('dismissal preserves a candidate and explicit reselection is possible; stale revisions refuse', async () => {
  const row = await service.stage({ sourceId: 'manual' });
  const dismissed = await service.review(row.id, { expectedRevision: row.revision, decision: 'dismiss', reviewer: 'Synthetic reviewer' });
  expect(dismissed.state).toBe('dismissed');
  await expect(promote(dismissed)).rejects.toMatchObject({ statusCode: 409 });
  await expect(service.review(row.id, { expectedRevision: '0'.repeat(64), decision: 'select', reviewer: 'Synthetic' })).rejects.toMatchObject({ statusCode: 409 });
  expect((await select(dismissed)).state).toBe('selected');
});

test('a lost response reconciles by identity and concurrent requests never repeat the RAG write', async () => {
  const row = await select(await service.stage({ sourceId: 'manual' }));
  const normal = rag.upsertDocumentWithChunks.getMockImplementation();
  rag.upsertDocumentWithChunks.mockImplementation(async (...args) => { await normal(...args); throw new Error('lost reply'); });
  const requestId = randomUUID();
  const results = await Promise.allSettled([promote(row, { requestId }), promote(row, { requestId })]);
  expect(results.some(result => result.status === 'fulfilled')).toBe(true);
  expect((await promote(row, { requestId })).state).toBe('promoted');
  expect(rag.upsertDocumentWithChunks).toHaveBeenCalledTimes(1);
});

test('a promotion request identity cannot be reused for another candidate', async () => {
  config.documents.push({ ...config.documents[0], id: 'another-export' }); await save();
  const first = await select(await service.stage({ sourceId: 'manual' }));
  const second = await select(await service.stage({ sourceId: 'another-export' }));
  const requestId = randomUUID();
  await promote(first, { requestId });
  await expect(promote(second, { requestId })).rejects.toMatchObject({ statusCode: 409 });
  expect((await service.get(second.id)).state).toBe('selected');
  expect(rag.upsertDocumentWithChunks).toHaveBeenCalledTimes(1);
});

test.each(['missing', 'partial', 'wrong-labels', 'wrong-content', 'wrong-source', 'missing-count', 'missing-revision'])('an uncertain %s result retains the dispatch fence across service restart', async fault => {
  const row = await select(await service.stage({ sourceId: 'manual' }));
  const normal = rag.upsertDocumentWithChunks.getMockImplementation();
  rag.upsertDocumentWithChunks.mockImplementation(async (text, metadata) => {
    if (fault === 'missing') throw new Error('unknown dispatch');
    await normal(text, metadata);
    const doc = docs.get(metadata.documentId);
    if (fault === 'partial') doc.metadata.mixedRevision = true;
    if (fault === 'wrong-labels') doc.metadata.scope = 'owner';
    if (fault === 'wrong-content') doc.metadata.contentHash = '0'.repeat(64);
    if (fault === 'wrong-source') doc.source = 'other-source';
    if (fault === 'missing-count') delete doc.chunkCount;
    if (fault === 'missing-revision') delete doc.metadata.revisionFingerprint;
  });
  const requestId = randomUUID();
  expect((await promote(row, { requestId })).state).toBe('uncertain');
  service = createDocumentCandidates({ archive, rag, targetSource: () => target, now: () => now });
  expect((await promote(row, { requestId })).state).toBe('uncertain');
  await expect(promote(row)).rejects.toMatchObject({ statusCode: 409 });
  await expect(service.review(row.id, { expectedRevision: row.revision, decision: 'dismiss', reviewer: 'Synthetic' })).rejects.toMatchObject({ statusCode: 409 });
  expect(rag.upsertDocumentWithChunks).toHaveBeenCalledTimes(1);
});

test('reconciliation can verify the original late result but never overwrites an existing target', async () => {
  const row = await select(await service.stage({ sourceId: 'manual' }));
  docs.set(`household-approved-${row.id}`, { documentId: 'foreign' });
  await expect(promote(row)).rejects.toMatchObject({ statusCode: 409 });
  expect(rag.upsertDocumentWithChunks).not.toHaveBeenCalled();
  docs.clear();
  const normal = rag.upsertDocumentWithChunks.getMockImplementation();
  rag.upsertDocumentWithChunks.mockRejectedValueOnce(new Error('lost'));
  const requestId = randomUUID();
  const uncertain = await promote(row, { requestId });
  expect(uncertain.state).toBe('uncertain');
  await normal(row.text, uncertain.target);
  expect((await promote(row, { requestId })).state).toBe('promoted');
  expect(rag.upsertDocumentWithChunks).toHaveBeenCalledTimes(1);
});

test('configured intake is bounded, traversal-free, UTF-8, explicit-classification and read-only', async () => {
  expect(await createDocumentArchive({ configPath: path.join(root, 'missing.json') }).list()).toMatchObject({ configured: false });
  for (const file of ['../manual.md', '/tmp/manual.md', 'folder/../manual.md', 'folder\\manual.md', 'file.pdf']) {
    config.documents[0].relativePath = file; await save();
    await expect(archive.read('manual')).rejects.toMatchObject({ statusCode: 400 });
  }
  config.documents[0].relativePath = 'manual.md'; delete config.documents[0].scope; await save();
  await expect(archive.read('manual')).rejects.toMatchObject({ statusCode: 400 });
  config.documents[0].scope = 'owner'; await save();
  await fs.writeFile(path.join(root, 'manual.md'), Buffer.from([0xff, 0x00]));
  await expect(archive.read('manual')).rejects.toMatchObject({ statusCode: 400 });
  await fs.writeFile(path.join(root, 'manual.md'), Buffer.alloc(MAX_BYTES + 1, 'x'));
  await expect(archive.read('manual')).rejects.toMatchObject({ statusCode: 413 });
  await fs.unlink(path.join(root, 'manual.md')); await fs.symlink(configPath, path.join(root, 'manual.md'));
  await expect(archive.read('manual')).rejects.toMatchObject({ statusCode: 400 });
  config.documents[0].relativePath = 'alias/candidates.txt'; await fs.symlink(root, path.join(root, 'alias')); await save();
  await expect(archive.read('manual')).rejects.toMatchObject({ statusCode: 400 });
});

test('source and candidate pagination does not silently hide further entries', async () => {
  config.documents = Array.from({ length: 22 }, (_, i) => ({ ...config.documents[0], id: `synthetic-${i}` })); await save();
  expect(await archive.list()).toMatchObject({ total: 22, nextOffset: 20 });
  expect((await archive.list({ offset: 20 })).entries).toHaveLength(2);
  for (const doc of config.documents) await service.stage({ sourceId: doc.id });
  expect((await service.list()).nextOffset).toBe(20);
  expect((await service.list({ offset: 20 })).entries).toHaveLength(2);
});

test('HTTP review flow excludes family APIs and rejects caller-supplied labels or text', async () => {
  const app = express();
  app.use(cookieParser());
  familyDevice.register({ app, mongoose, standardJsonParser: express.json(),
    envelope: (res, data, code = 200) => res.status(code).json({ ok: true, data }),
    fail: (res, code, message, reason) => res.status(code).json({ ok: false, message, code: reason }),
    ownerUnlock: { activeUntil: async () => null } });
  // Avoid rendering a page: the API uses the real service and disposable Mongo.
  jest.spyOn(require('../../src/ui/productShell'), 'surfacePage').mockReturnValue((_req, res) => res.send('synthetic page'));
  registerDocumentCandidateRoutes({ app, jsonParser: express.json(), service });
  const base = '/api/voice-personas/private/document-candidates';
  const pin = await request(app).post('/api/household/family-device/pin').send({ label: 'Synthetic locked device' }).expect(201);
  const cookie = pin.headers['set-cookie'];
  await request(app).get('/dad/documents').set('Cookie', cookie).expect(302).expect('Location', '/panel');
  for (const suffix of ['', '/sources', '/' + 'a'.repeat(64)]) {
    const refused = await request(app).get(base + suffix).set('Cookie', cookie).expect(403);
    expect(refused.body.code).toBe('FAMILY_DEVICE_PINNED');
  }
  for (const suffix of ['', '/' + 'a'.repeat(64) + '/review', '/' + 'a'.repeat(64) + '/promote']) {
    await request(app).post(base + suffix).set('Cookie', cookie).send({}).expect(403);
  }
  const staged = await request(app).post(base).send({ sourceId: 'manual' }).expect(200);
  const row = staged.body.data;
  expect(staged.headers['cache-control']).toBe('private, no-store');
  await request(app).post(base).send({ sourceId: 'manual', text: 'injected' }).expect(400);
  await request(app).post(`${base}/${row.id}/review`).send({ expectedRevision: row.revision,
    decision: 'select', reviewer: 'Synthetic HTTP reviewer', scope: 'household' }).expect(400);
  await request(app).post(`${base}/${row.id}/review`).send({ expectedRevision: row.revision,
    decision: 'select', reviewer: 'Synthetic HTTP reviewer' }).expect(200);
  const result = await request(app).post(`${base}/${row.id}/promote`).send({ expectedRevision: row.revision,
    requestId: randomUUID(), confirmation: `SHARE ${row.id}` }).expect(200);
  expect(result.body.data.state).toBe('promoted');
  await request(app).get('/api/voice-personas/family/document-candidates').expect(404);
  jest.restoreAllMocks();
});
