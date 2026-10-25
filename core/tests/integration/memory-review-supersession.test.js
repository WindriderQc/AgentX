'use strict';

jest.mock('../../src/services/ragServiceClient', () => ({ getRagServiceClient: () => ({
  searchSimilarChunks: async () => [], upsertDocumentWithChunks: async () => { throw new Error('No RAG writes allowed'); },
}) }));
jest.mock('../../src/services/memoryNoteIndex', () => {
  const actual = jest.requireActual('../../src/services/memoryNoteIndex');
  return { ...actual, createIndex: () => actual.createIndex({ embed: async () => [1, 0], model: () => 'synthetic-review-index' }) };
});

const express = require('express');
const request = require('supertest');
const Run = require('../../models/MemoryReviewRun');
const Note = require('../../models/MemoryNote');
const { personal } = require('../../src/services/memoryNoteService');
const dedup = require('../../src/services/memoryReview/dedupService');
const { createIndex } = require('../../src/services/memoryNoteIndex');
const app = express();
app.use(express.json());
app.use('/api/memory-review', require('../../routes/memory-review'));
const base = '/api/memory-review/runs/synthetic-replacement-run';
let old, proposed;
const priorMode = process.env.MEMORY_REVIEW_MODE;
const priorAutomation = process.env.MEMORY_REVIEW_AUTOMATION_MODE;
afterAll(() => { if (priorMode === undefined) delete process.env.MEMORY_REVIEW_MODE; else process.env.MEMORY_REVIEW_MODE = priorMode;
  if (priorAutomation === undefined) delete process.env.MEMORY_REVIEW_AUTOMATION_MODE; else process.env.MEMORY_REVIEW_AUTOMATION_MODE = priorAutomation; });

beforeEach(async () => {
  await Run.deleteMany({}); await Note.deleteMany({});
  process.env.MEMORY_REVIEW_MODE = 'apply'; process.env.MEMORY_REVIEW_AUTOMATION_MODE = 'safe';
  old = await personal().remember({ text: 'Synthetic backup uses host A' });
  await createIndex().indexNote(old.id, old.text);
  const observations = [{ observationId: 'obs-synthetic', runtime: 'codex', host: 'synthetic',
    sessionId: 'synthetic-owner-session', trust: 'explicit_memory_request', text: 'Synthetic backup now uses host B',
    contentHash: 'a'.repeat(64) }];
  const context = await dedup.buildRagDedupContext(observations);
  await Run.create({ runId: 'synthetic-replacement-run', runKey: 'synthetic-replacement', status: 'synthesizing',
    observations, dedupContext: context });
  proposed = { type: 'supersedes', statement: 'Synthetic backup now uses host B', rationale: 'The owner explicitly changed the host',
    target: { kind: 'shared_fact' }, evidenceRefs: ['obs-synthetic'], confidence: 1, scope: 'owner', sensitivity: 'private',
    supersedes: { authority: 'local_memory', ref: old.id } };
});

async function submit(value = proposed) {
  const response = await request(app).post(base + '/candidates').send({ candidates: [value] }).expect(200);
  const candidate = (await Run.findOne({ runId: 'synthetic-replacement-run' }).lean()).candidates[0];
  return { response, candidate, path: candidate ? `${base}/candidates/${candidate.candidateId}` : null };
}
async function reviewed() {
  const result = await submit();
  await request(app).post(result.path + '/review').send({ action: 'approve' }).expect(200);
  await request(app).post(base + '/authorize-apply').send({}).expect(200);
  return result;
}

test('a proved owner replacement remains an individual human exception even at maximum confidence', async () => {
  const { candidate, path } = await submit();
  expect(candidate).toMatchObject({ type: 'supersedes', status: 'proposed', automation: { disposition: 'review' },
    supersedes: { authority: 'local_memory', ref: old.id, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(await Note.countDocuments()).toBe(1);
  await request(app).post(path + '/apply').send({}).expect(403);
  await request(app).post(base + '/authorize-apply').send({}).expect(409);
  expect(await Note.countDocuments()).toBe(1);
});

test('a model cannot fabricate its own conflict or a stored fingerprint', async () => {
  const invented = 'f'.repeat(24);
  const { response } = await submit({ ...proposed, supersedes: { authority: 'local_memory', ref: invented },
    conflicts: [{ authority: 'local_memory', sourceRef: invented, summary: 'Synthetic model assertion' }] });
  expect(response.body.data).toMatchObject({ accepted: 0, dropped: [expect.any(Object)] });
  expect(await Note.countDocuments()).toBe(1);
});

test('household candidates and model-supplied source fingerprints are dropped', async () => {
  for (const value of [{ ...proposed, scope: 'household' },
    { ...proposed, supersedes: { ...proposed.supersedes, fingerprint: 'f'.repeat(64) } }]) {
    const { response } = await submit(value);
    expect(response.body.data.accepted).toBe(0);
    // Empty synthesis completes the run; restore the fixture state for the next malformed input.
    await Run.updateOne({ runId: 'synthetic-replacement-run' }, { $set: { status: 'synthesizing' } });
  }
});

test('review, apply, current recall, owner history and rollback work through the existing HTTP boundary', async () => {
  const { path } = await reviewed();
  const applied = await request(app).post(path + '/apply').send({}).expect(200);
  expect(applied.body.data.status).toBe('applied');
  const [current] = (await personal().list()).notes;
  expect(current.text).toBe(proposed.statement);
  const history = (await personal().list({ includeHistory: true })).notes;
  expect(history.find(note => note.id === old.id)).toMatchObject({ text: old.text, supersededBy: current.id });
  expect(current.sourceRefs).toEqual([{ system: 'memory-review', id: `synthetic-replacement-run:${applied.body.data.candidateId}` }]);
  const rpc = await require('../../src/services/mcpOwnerTools').handleOwnerMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'personal_memory', arguments: { action: 'list', includeHistory: true } } });
  expect(rpc.result.structuredContent.notes).toEqual(expect.arrayContaining([expect.objectContaining({ id: old.id, supersededBy: current.id })]));
  const replay = await request(app).post(path + '/apply').send({}).expect(200);
  expect(replay.body.data.alreadyApplied).toBe(true);
  expect((await request(app).post(path + '/rollback').send({}).expect(200)).body.data.status).toBe('rolled_back');
  expect((await personal().list()).notes.map(note => note.id)).toEqual([old.id]);
  expect((await Note.findById(current.id).lean()).status).toBe('forgotten');
  expect((await request(app).post(path + '/rollback').send({}).expect(200)).body.data.alreadyRolledBack).toBe(true);
  await request(app).post(path + '/apply').send({}).expect(409);
});

test('source edits after review fail application without creating a successor', async () => {
  const { path } = await reviewed();
  await personal().remember({ id: old.id, text: 'Synthetic changed source after review' });
  await request(app).post(path + '/apply').send({}).expect(502);
  expect((await Run.findOne({ runId: 'synthetic-replacement-run' }).lean()).candidates[0].status).toBe('apply_failed');
  expect(await Note.countDocuments()).toBe(1);
  expect((await personal().list()).notes[0].text).toBe('Synthetic changed source after review');
});

test('rollback keeps the same server and per-run authorization gates and refuses a changed successor', async () => {
  const { path } = await reviewed();
  await request(app).post(path + '/apply').send({}).expect(200);
  process.env.MEMORY_REVIEW_MODE = 'shadow';
  await request(app).post(path + '/rollback').send({}).expect(403);
  process.env.MEMORY_REVIEW_MODE = 'apply';
  const [current] = (await personal().list()).notes;
  await personal().remember({ id: current.id, text: 'Synthetic successor updated independently' });
  const refused = await request(app).post(path + '/rollback').send({}).expect(200);
  expect(refused.body.data.status).toBe('rollback_failed');
  expect((await personal().list()).notes[0].text).toBe('Synthetic successor updated independently');
});
