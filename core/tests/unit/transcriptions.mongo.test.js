'use strict';
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');
const Model = require('../../models/Transcription');
const Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive');
const Runtime = require('../../models/RuntimeCoordination');
const service = require('../../src/services/transcriptionService');
const executor = require('../../src/services/transcriptionExecutor');
const coordination = require('../../src/services/runtimeCoordinationService');
const queue = require('../../src/services/heavyWorkQueueService');
const launcher = require('../../src/services/heavyWorkQueueLauncher');
const evidence = require('../../src/services/heavyWorkQueueEvidence');
const { createRouter } = require('../../routes/transcriptions');
const { youtubeUrl, srt } = require('../../src/services/transcriptionContract');
const base = 'http://127.0.0.1:18091';
const input = (extra = {}) => ({ requestKey: crypto.randomUUID(), url: 'https://youtu.be/abcdefghijk', timeZone: 'America/Toronto', ...extra });
let receipts, starts, failStart, app;
beforeEach(async () => {
  process.env.TRANSCRIPTIONS_ENABLED = 'true'; process.env.VOIX_BASE_URL = base;
  delete process.env.TRANSCRIPTION_RESOURCE_HOSTS;
  process.env.AGENTX_RUNTIME_RESOURCES_JSON = JSON.stringify([{ id: 'fixture-speech-gpu', endpoints: [base, 'http://127.0.0.1:11434'] }]);
  await Model.deleteMany({}); await Queue.deleteMany({}); await Archive.deleteMany({}); await Runtime.deleteMany({});
  receipts = new Map(); starts = 0; failStart = false;
  jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/capabilities')) return new Response(JSON.stringify({ contract: 'voix.long-transcriptions/v1', durable: true }));
    if (options.method === 'POST' && path.endsWith('/long-transcriptions')) {
      starts++;
      const body = JSON.parse(options.body);
      receipts.set(body.id, { ...body, state: 'running', stage: 'transcribing', startedAt: Date.now() / 1000 });
      if (failStart) throw Error('Synthetic lost response after acceptance');
      return new Response(JSON.stringify(receipts.get(body.id)));
    }
    const id = path.split('/')[4];
    if (path.endsWith('/cancel')) receipts.set(id, { ...receipts.get(id), state: 'running', stage: 'cancelling' });
    return new Response(JSON.stringify(receipts.get(id)));
  });
  app = express(); app.use('/api/transcriptions', createRouter());
});
afterEach(() => { jest.restoreAllMocks(); delete process.env.AGENTX_RUNTIME_RESOURCES_JSON; });
async function launch(row) {
  const job = await queue.get(row.queueId);
  return launcher.launch(job.id, 'test', { expectedRevision: job.revision });
}
function finish(id, state = 'completed') {
  receipts.set(id, { ...receipts.get(id), state, stage: state, finishedAt: Date.now() / 1000,
    title: '<img src=x onerror=alert(1)> Fixture', duration: 2.5,
    result: { text: 'Bonjour la maison.', detectedLanguage: 'fr', segments: [{ start: .1, end: 2.5, text: 'Bonjour la maison.' }] } });
}
it('rejects other schemes, private addresses, lookalike domains, playlists and past schedules', async () => {
  for (const url of ['http://youtube.com/watch?v=abcdefghijk', 'https://127.0.0.1/a', 'https://youtube.com.evil.test/watch?v=abcdefghijk', 'https://www.youtube.com/playlist?list=abc', 'https://user:pass@youtube.com/watch?v=abcdefghijk']) {
    expect(() => youtubeUrl(url)).toThrow();
  }
  expect(youtubeUrl('https://www.youtube.com/shorts/abcdefghijk?list=ignored')).toBe('https://www.youtube.com/watch?v=abcdefghijk');
  await expect(service.create(input({ startAt: '2020-01-01T10:00:00Z' }))).rejects.toThrow('future');
  await expect(service.create(input({ startAt: '2027-01-01T10:00:00' }))).rejects.toThrow('décalage');
  expect(await Model.countDocuments()).toBe(0);
});
it('deduplicates concurrent clicks and survives service module reload with a durable schedule', async () => {
  const body = input({ startAt: new Date(Date.now() + 3600000).toISOString() });
  const rows = await Promise.all([service.create(body), service.create(body)]);
  expect(rows[0]._id).toBe(rows[1]._id);
  expect(await Model.countDocuments()).toBe(1);
  expect((await queue.list()).jobs).toHaveLength(1);
  expect((await queue.get(rows[0].queueId)).reservation.autoStart).toBe(true);
  expect((await queue.get(rows[0].queueId)).reservation.start).toBe(body.startAt);
  await launcher.dispatchDue();
  expect(starts).toBe(0);
  await expect(service.create({ ...body, url: 'https://youtu.be/lmnopqrstuv' })).rejects.toThrow('autre demande');
  expect((await service.list()).rows[0].requestedAt.toISOString()).toBe(body.startAt);
});
it('recovers a lost native answer by identity without replay, exports segments and persists completed results', async () => {
  const row = await service.create(input()); failStart = true;
  await expect(launch(row)).rejects.toMatchObject({ code: 'HEAVY_QUEUE_LAUNCH_UNCERTAIN' });
  expect((await queue.get(row.queueId)).state).toBe('uncertain');
  await evidence.reconcile(row.queueId, 'observer');
  expect((await queue.get(row.queueId)).state).toBe('running');
  await launcher.dispatchDue(); expect(starts).toBe(1);
  finish(row.queueId);
  await evidence.reconcile(row.queueId, 'observer');
  expect((await queue.get(row.queueId)).state).toBe('completed');
  const saved = await service.get(row._id, true);
  expect(saved.result.segments[0].start).toBe(.1);
  expect(saved.detectedLanguage).toBe('fr');
  expect((await Runtime.findById('runtime').lean()).workloads).toHaveLength(0);
  const txt = await request(app).get('/api/transcriptions/' + row._id + '/export/txt').expect(200);
  expect(txt.text).toContain('Bonjour');
  const subtitle = await request(app).get('/api/transcriptions/' + row._id + '/export/srt').expect(200);
  expect(subtitle.text || subtitle.body.toString()).toContain('00:00:00,100 --> 00:00:02,500');
  expect((await service.list({ search: 'Bonjour' })).count).toBe(1);
  expect((await service.list({ search: '.*' })).count).toBe(0);
});
it('cancels queued tasks and retries idempotently with a linked new attempt', async () => {
  const row = await service.create(input({ startAt: new Date(Date.now() + 60000).toISOString() }));
  await service.cancel(row._id);
  expect((await queue.get(row.queueId)).state).toBe('cancelled');
  const body = { requestKey: crypto.randomUUID() };
  const again = await service.retry(row._id, body);
  const same = await service.retry(row._id, body);
  expect(again._id).toBe(same._id);
  expect(again.retryOf).toBe(row._id);
  expect(await Model.countDocuments()).toBe(2);
});
it('keeps the active fence until cancellation has actually ended native decoding', async () => {
  const row = await service.create(input()); await launch(row);
  await service.cancel(row._id); await evidence.reconcile(row.queueId, 'observer');
  expect((await queue.get(row.queueId)).state).toBe('running');
  await expect(service.retry(row._id, { requestKey: crypto.randomUUID() })).rejects.toThrow('fin confirmée');
  expect((await Runtime.findById('runtime').lean()).workloads).toHaveLength(1);
  finish(row.queueId, 'cancelled');
  await evidence.reconcile(row.queueId, 'observer');
  expect((await service.get(row._id)).state).toBe('cancelled');
  expect((await Runtime.findById('runtime').lean()).workloads).toHaveLength(0);
});
it('respects maintenance admission and exposes the failed attempt for retry', async () => {
  const row = await service.create(input());
  const lease = await coordination.acquireMaintenance({ principal: 'fixture-owner', requestId: 'fixture-maintenance', scope: 'deploy', ttl: 120000 });
  expect(lease.acquired).toBe(true);
  await expect(launch(row)).rejects.toThrow();
  expect(starts).toBe(0);
  expect((await queue.get(row.queueId)).state).toBe('failed');
  expect((await service.get(row._id)).state).toBe('failed');
});
it('retains the task across HTTP refresh and reports model/download failures without duplicate dispatch', async () => {
  const row = await service.create(input()); await launch(row);
  finish(row.queueId, 'failed'); receipts.get(row.queueId).error = 'Synthetic model unavailable';
  await evidence.reconcile(row.queueId, 'observer');
  await request(app).get('/api/transcriptions').expect(200).expect(res => expect(res.body.data.rows[0].state).toBe('failed'));
  await request(app).get('/api/transcriptions/' + row._id + '/export/txt').expect(409);
  expect(starts).toBe(1);
});

it('refuses an unmapped speech GPU before storing or dispatching a request', async () => {
  delete process.env.AGENTX_RUNTIME_RESOURCES_JSON;
  await expect(service.create(input())).rejects.toMatchObject({ code: 'TRANSCRIPTION_RESOURCE_UNMAPPED' });
  expect(await Model.countDocuments()).toBe(0);
});
it('keeps a resource alias held by another workload and launches no speech', async () => {
  const row = await service.create(input());
  const lease = await coordination.acquireWorkload({ principal: 'fixture-benchmark', requestId: 'fixture-claim', workloadId: 'fixture-claim',
    kind: 'benchmark', hosts: ['http://127.0.0.1:11434'], ttl: 120000 });
  expect(lease.acquired).toBe(true);
  await expect(launch(row)).rejects.toThrow(); expect(starts).toBe(0);
  expect((await Runtime.findById('runtime').lean()).workloads).toHaveLength(1);
});
it('shows an unavailable native receipt as a checkable state and never replaces it', async () => {
  const row = await service.create(input()); await launch(row);
  global.fetch.mockRejectedValueOnce(Error('Synthetic connection loss'));
  await expect(evidence.reconcile(row.queueId, 'observer')).rejects.toThrow();
  expect((await service.get(row._id)).state).toBe('uncertain');
  await launcher.dispatchDue(); expect(starts).toBe(1);
});
it('reads the result from a fresh Node process connected only to its isolated test database', async () => {
  const row = await service.create(input());
  const script = "const m=require('mongoose');(async()=>{await m.connect(process.env.TRANSCRIPTION_FIXTURE_MONGO);const r=await m.connection.db.collection('transcriptions').findOne({_id:process.env.TRANSCRIPTION_FIXTURE_ID});console.log(r.url);await m.disconnect()})().catch(e=>{console.error(e.message);process.exitCode=1})";
  const { execFile } = require('node:child_process');
  const result = await new Promise((resolve,reject) => execFile(process.execPath, ['-e', script], { cwd: require('node:path').resolve(__dirname, '../..'),
    env: { ...process.env, TRANSCRIPTION_FIXTURE_MONGO: process.env.MONGODB_URI_TEST, TRANSCRIPTION_FIXTURE_ID: row._id } }, (error,stdout) => error ? reject(error) : resolve(stdout)));
  expect(result.trim()).toBe(row.url);
});

it('keeps an unconfigured or old speech service unstarted before acquiring GPU admission', async () => {
  const row = await service.create(input());
  global.fetch.mockResolvedValueOnce(new Response('{}', { status: 404 }));
  await expect(launch(row)).rejects.toThrow();
  expect((await queue.get(row.queueId)).state).toBe('reserved');
  expect((await Runtime.findById('runtime').lean())?.workloads || []).toHaveLength(0);
  expect((await service.get(row._id)).error).toContain('pas prêt');
  expect(starts).toBe(0);
});

it('renews active admission independently of slow or unavailable native receipt reads', async () => {
  const row = await service.create(input()); await launch(row);
  const calls = global.fetch.mock.calls.length;
  global.fetch.mockRejectedValue(Error('Synthetic native outage'));
  expect(await executor.heartbeatActive()).toEqual({ renewed: 1, refused: 0 });
  expect(global.fetch.mock.calls).toHaveLength(calls);
  expect(starts).toBe(1);
});

it('admits only one active retry across tabs carrying different request identities', async () => {
  const row = await service.create(input()); await service.cancel(row._id);
  const results = await Promise.allSettled([
    service.retry(row._id, { requestKey: crypto.randomUUID() }),
    service.retry(row._id, { requestKey: crypto.randomUUID() })
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(await Model.countDocuments({ retryOf: row._id })).toBe(1);
});
it('does not wrap subtitle hours after a day when the configured resource budget permits it', () => {
  expect(srt([{ start: 90000.125, end: 90001.75, text: 'Long fixture' }])).toContain('25:00:00,125 --> 25:00:01,750');
});

it('does not revive expired admission during restart recovery or replay native work', async () => {
  const row = await service.create(input()); await launch(row);
  await Runtime.updateOne({ _id: 'runtime' }, { $set: { 'workloads.0.expiresAt': new Date(Date.now() - 1000) } });
  expect(await executor.heartbeatActive()).toEqual({ renewed: 0, refused: 1 });
  await expect(evidence.reconcile(row.queueId, 'restarted-observer')).rejects.toThrow();
  expect((await service.get(row._id)).state).toBe('uncertain');
  expect(starts).toBe(1);
  expect((await Runtime.findById('runtime').lean()).workloads).toHaveLength(1);
});
it('replays a lost retry answer and allows another deliberate retry only after the previous child settles', async () => {
  const row = await service.create(input()); await service.cancel(row._id);
  const key = crypto.randomUUID();
  const child = await service.retry(row._id, { requestKey: key });
  expect((await service.retry(row._id, { requestKey: key }))._id).toBe(child._id);
  await service.cancel(child._id);
  const next = await service.retry(row._id, { requestKey: crypto.randomUUID() });
  expect(next._id).not.toBe(child._id);
  expect(await Model.countDocuments({ retryOf: row._id })).toBe(2);
});

it('renews the same persisted lease from a fresh Core process after restart', async () => {
  const row = await service.create(input()); await launch(row);
  const script = "const m=require('mongoose');(async()=>{await m.connect(process.env.TRANSCRIPTION_FIXTURE_MONGO,{autoCreate:false,autoIndex:false});const e=require('./src/services/transcriptionExecutor');console.log(JSON.stringify(await e.heartbeatActive()));await m.disconnect()})().catch(e=>{console.error(e.message);process.exitCode=1})";
  const { execFile } = require('node:child_process');
  const output = await new Promise((resolve,reject) => execFile(process.execPath, ['-e', script], { cwd: require('node:path').resolve(__dirname, '../..'),
    env: { ...process.env, TRANSCRIPTION_FIXTURE_MONGO: process.env.MONGODB_URI_TEST } }, (error,stdout) => error ? reject(error) : resolve(stdout)));
  expect(output).toContain('"renewed":1');
  expect(starts).toBe(1);
  expect((await Runtime.findById('runtime').lean()).workloads).toHaveLength(1);
});

it('repairs a crash between retry acceptance and child creation under the original identity', async () => {
  const row = await service.create(input()); await service.cancel(row._id);
  const accepted = crypto.randomUUID();
  await Model.updateOne({ _id: row._id }, { $set: { retryRequestId: accepted } });
  await expect(service.retry(row._id, { requestKey: crypto.randomUUID() })).rejects.toThrow('récupérée');
  const child = await service.get(accepted);
  expect(child.retryOf).toBe(row._id);
  expect((await service.retry(row._id, { requestKey: accepted }))._id).toBe(accepted);
  expect(await Model.countDocuments({ retryOf: row._id })).toBe(1);
});
