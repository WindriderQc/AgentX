'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { createPhotoImportService } = require('../../../core/src/services/photos/photoImportService');
const { createPhoneLibrary } = require('../../../core/src/services/photos/phoneLibrary');
const { createPhoneCleanup } = require('../../../core/src/services/photos/phoneCleanup');
const { executePhoneCleanup } = require('../../../core/src/services/photos/phoneCleanupExecution');
const { createPhoneWorkbench } = require('../../../core/src/services/photos/phoneWorkbench');
const { checkpoint } = require('../import.cjs');
const { lockCache } = require('../transport.cjs');
const uuid = () => crypto.randomUUID(),
  sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-ui-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runId = uuid(),
    requestId = uuid(),
    bytes = Buffer.from('private synthetic image bytes'),
    source = {
      requestId,
      key: 'persistent-one',
      name: 'same.jpg',
      relativePath: 'Storage/DCIM/same.jpg',
      size: bytes.length,
      modified: '64:100',
    };
  const importer = await createPhotoImportService({ root });
  await importer.begin({
    runId,
    deviceKey: sha('phone'),
    sources: [source],
    coverage: { enumerationComplete: true, remaining: 0 },
  });
  const header = { runId, requestId, size: bytes.length, sha256: sha(bytes) };
  const receipt = await importer.receive(header, Readable.from([bytes]));
  const library = await createPhoneLibrary({ root });
  const cleanup = createPhoneCleanup(library);
  return { root, runId, requestId, source, bytes, header, receipt, library, cleanup };
}
async function plan(f) {
  return f.cleanup.prepare({ runId: f.runId, planId: uuid(), items: [f.requestId] });
}
function transport(f) {
  return async (header, { json }) => {
    if (header.action !== 'library') throw Error('Unexpected transport');
    const { op, ...input } = json;
    return {
      plan: (x) => f.cleanup.prepared(x.planId),
      authorize: f.cleanup.authorize,
      deleted: f.cleanup.record,
      cleanupStatus: f.cleanup.status,
    }[op](input);
  };
}
function native(f) {
  return {
    devices: async () => [{ id: 'phone' }],
    inventory: async () => ({
      complete: true,
      errors: [],
      files: [{ ...f.source, objectId: 'ephemeral-current' }],
    }),
  };
}

test('existing imports are browseable; reviews persist and cannot overwrite concurrent choices', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.library.list()).runs[0].selected, 1);
  const page = await f.library.page({ runId: f.runId });
  assert.equal(page.items[0].backup.disposition, 'copied');
  const write = {
    runId: f.runId,
    requestId: f.requestId,
    writeId: uuid(),
    choice: 'archive',
    expectedRevision: 0,
  };
  const review = await f.library.setReview(write);
  assert.equal(review.choice, 'archive');
  assert.deepEqual(await f.library.setReview(write), review);
  await assert.rejects(f.library.setReview({ ...write, writeId: uuid(), choice: 'keep' }), {
    code: 'REVIEW_CHANGED',
  });
  assert.equal((await createPhoneLibrary({ root: f.root })).review instanceof Function, true);
  assert.equal(
    (await (await createPhoneLibrary({ root: f.root })).review(f.runId, f.requestId)).choice,
    'archive',
  );
  assert.deepEqual(await fs.readFile(f.receipt.path), f.bytes);
});

test('pagination/search stays within the chosen import and exposes no archive path', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.library.page({ runId: f.runId, search: 'DCIM', limit: 1 })).items.length, 1);
  assert.equal((await f.library.page({ runId: f.runId, search: 'absent' })).total, 0);
  assert.equal(JSON.stringify(await f.library.page({ runId: f.runId })).includes(f.receipt.path), false);
  await assert.rejects(f.library.page({ runId: '../outside' }), { code: 'INVALID_ID' });
  await assert.rejects(f.library.page({ runId: f.runId, limit: 101 }), { code: 'INVALID_QUERY' });
});

test('preparing a plan is stable and has no phone-side effect', async (t) => {
  const f = await fixture(t);
  const input = { runId: f.runId, planId: uuid(), items: [f.requestId] },
    p = await f.cleanup.prepare(input);
  assert.equal(p.items[0].sha256, f.header.sha256);
  assert.deepEqual(await f.cleanup.prepare(input), p);
  assert.equal((await f.cleanup.status({ planId: p.planId })).results[0].state, 'not-started');
  await assert.rejects(
    f.cleanup.authorize({
      planId: p.planId,
      operationId: uuid(),
      requestId: f.requestId,
      digest: p.digest,
      confirmation: 'yes',
      sha256: f.header.sha256,
      attemptId: uuid(),
    }),
    { code: 'CONFIRMATION_REQUIRED' },
  );
});

test('a missing or corrupted Media destination blocks preparation and just-in-time authorization', async (t) => {
  const f = await fixture(t),
    p = await plan(f);
  await fs.writeFile(f.receipt.path, 'corrupt');
  await assert.rejects(plan(f), { code: 'COPY_VERIFICATION_FAILED' });
  await assert.rejects(
    f.cleanup.authorize({
      planId: p.planId,
      operationId: uuid(),
      requestId: f.requestId,
      digest: p.digest,
      confirmation: p.confirmation,
      sha256: f.header.sha256,
      attemptId: uuid(),
    }),
    { code: 'COPY_VERIFICATION_FAILED' },
  );
  assert.equal((await f.cleanup.status({ planId: p.planId })).results[0].state, 'not-started');
});

test('a source claim fences a replacement operation after an uncertain dispatch', async (t) => {
  const f = await fixture(t),
    p = await plan(f);
  const input = {
    planId: p.planId,
    operationId: uuid(),
    requestId: f.requestId,
    digest: p.digest,
    confirmation: p.confirmation,
    sha256: f.header.sha256,
    attemptId: uuid(),
  };
  await f.cleanup.authorize(input);
  assert.deepEqual(await f.cleanup.authorize(input), await f.cleanup.authorize(input));
  assert.equal((await f.cleanup.status({ planId: p.planId })).results[0].state, 'uncertain');
  await assert.rejects(f.cleanup.authorize({ ...input, operationId: uuid() }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(plan(f), { code: 'SOURCE_CLEANUP_HELD' });
});

test('cleanup verifies phone bytes then Media before granting one exact native deletion', async (t) => {
  const f = await fixture(t),
    p = await plan(f),
    operationId = uuid();
  let effects = 0;
  const remove = async (request, authorize) => {
    assert.equal(request.item.objectId, 'ephemeral-current');
    const grant = await authorize({ attemptId: uuid(), sha256: f.header.sha256, size: f.bytes.length });
    effects++;
    return { ...grant, state: 'deleted' };
  };
  const input = { planId: p.planId, digest: p.digest, confirmation: p.confirmation, operationId };
  const result = await executePhoneCleanup({
    input,
    remote: transport(f),
    source: native(f),
    enabled: true,
    remove,
  });
  assert.equal(effects, 1);
  assert.equal(result.deleted, 1);
  await executePhoneCleanup({ input, remote: transport(f), source: native(f), enabled: true, remove });
  assert.equal(effects, 1, 'received deletions are not repeated');
  assert.deepEqual(await fs.readFile(f.receipt.path), f.bytes);
});

test('wrong phone, changed source, disabled cleanup and mismatched confirmation cause zero deletions', async (t) => {
  const f = await fixture(t),
    p = await plan(f),
    input = { planId: p.planId, digest: p.digest, confirmation: p.confirmation, operationId: uuid() };
  let effects = 0;
  const remove = async (request, authorize) => {
    const grant = await authorize({ attemptId: uuid(), sha256: '0'.repeat(64), size: f.bytes.length });
    effects++;
    return { ...grant, state: 'deleted' };
  };
  const options = { input, remote: transport(f), source: native(f), enabled: true, remove };
  await assert.rejects(executePhoneCleanup({ ...options, enabled: false }), { code: 'CLEANUP_DISABLED' });
  await assert.rejects(executePhoneCleanup({ ...options, input: { ...input, confirmation: 'wrong' } }), {
    code: 'CONFIRMATION_REQUIRED',
  });
  await assert.rejects(
    executePhoneCleanup({ ...options, source: { devices: async () => [{ id: 'other' }] } }),
    { code: 'PHONE_UNAVAILABLE' },
  );
  await assert.rejects(executePhoneCleanup(options), { code: 'SOURCE_CHANGED' });
  assert.equal(effects, 0);
});

test('native uncertainty stops the batch and keeps its grant; no replacement delete is sent', async (t) => {
  const f = await fixture(t),
    p = await plan(f);
  let effects = 0;
  const remove = async (_, authorize) => {
    await authorize({ attemptId: uuid(), sha256: f.header.sha256, size: f.bytes.length });
    effects++;
    throw Object.assign(new Error('USB ack lost'), { code: 'CLEANUP_UNCERTAIN' });
  };
  await assert.rejects(
    executePhoneCleanup({
      input: { planId: p.planId, digest: p.digest, confirmation: p.confirmation, operationId: uuid() },
      remote: transport(f),
      source: native(f),
      enabled: true,
      remove,
    }),
    { code: 'CLEANUP_UNCERTAIN' },
  );
  assert.equal(effects, 1);
  assert.equal((await f.cleanup.status({ planId: p.planId })).deleted, 0);
});

test('a received native success reconciles a lost Core acknowledgment without repeating deletion', async (t) => {
  const f = await fixture(t),
    p = await plan(f),
    operationId = uuid();
  let saved = null,
    effects = 0,
    lost = true;
  const actual = transport(f);
  const remote = async (h, payload) => {
    if (payload.json.op === 'deleted' && lost) {
      lost = false;
      throw Error('Network disconnected before Core receipt');
    }
    return actual(h, payload);
  };
  const remove = async (request, authorize) => {
    if (saved) return saved;
    const grant = await authorize({ attemptId: uuid(), sha256: f.header.sha256, size: f.bytes.length });
    effects++;
    saved = { ...grant, state: 'deleted' };
    return saved;
  };
  const options = {
    input: { planId: p.planId, digest: p.digest, confirmation: p.confirmation, operationId },
    remote,
    source: native(f),
    enabled: true,
    remove,
  };
  await assert.rejects(executePhoneCleanup(options));
  assert.equal((await executePhoneCleanup(options)).deleted, 1);
  assert.equal(effects, 1);
});

test('transport job retries preserve their request and import identity across disconnects', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-job-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let launches = 0;
  const api = createPhoneWorkbench({
    config: { cacheRoot: dir },
    checkpoint,
    lock: lockCache,
    source: {},
    remote: () => {},
    launch: async () => ++launches,
    alive: async () => true,
    importer: async (config, options) => {
      assert.equal(options.initialRunId, requestId);
      return { state: 'incomplete', counts: { pending: 1 }, failures: [{ code: 'TRANSPORT_OR_SOURCE_FAILED', message: 'USB device unavailable (0x80070141)' }] };
    },
  });
  const requestId = uuid(),
    input = { op: 'start', kind: 'import', requestId };
  await api.command(input);
  await api.command(input);
  assert.equal(launches, 1);
  await api.run(requestId);
  const status = (await api.command({ op: 'status' })).jobs[0];
  assert.equal(status.state, 'incomplete');
  assert.equal(status.error.code, 'TRANSPORT_OR_SOURCE_FAILED');
  assert.match(status.error.message, /0x80070141/);
  await assert.rejects(api.command({ ...input, resume: uuid() }), { code: 'REQUEST_CONFLICT' });
});

test('durable native success can repair Core with the phone disconnected', async (t) => {
  const f = await fixture(t),
    p = await plan(f),
    operationId = uuid();
  const grant = await f.cleanup.authorize({
    planId: p.planId,
    operationId,
    requestId: f.requestId,
    digest: p.digest,
    confirmation: p.confirmation,
    sha256: f.header.sha256,
    attemptId: uuid(),
  });
  const remove = async () => assert.fail('No new native deletion');
  remove.reconcile = async () => ({ ...grant, state: 'deleted' });
  const result = await executePhoneCleanup({
    input: { planId: p.planId, digest: p.digest, confirmation: p.confirmation, operationId },
    remote: transport(f),
    source: {
      devices: async () => assert.fail('No connected phone is needed to receive an existing success'),
    },
    enabled: true,
    remove,
  });
  assert.equal(result.deleted, 1);
  assert.equal((await f.library.page({ runId: f.runId })).items[0].phone, 'deleted');
});

test('cleanup fences follow the exact content occurrence, not an unrelated later file at the same path', async (t) => {
  const f = await fixture(t),
    p = await plan(f),
    operationId = uuid();
  const grant = await f.cleanup.authorize({
    planId: p.planId,
    operationId,
    requestId: f.requestId,
    digest: p.digest,
    confirmation: p.confirmation,
    sha256: f.header.sha256,
    attemptId: uuid(),
  });
  await f.cleanup.record({ ...grant, state: 'deleted' });
  const importer = await createPhotoImportService({ root: f.root });
  for (const modified of [f.source.modified, '64:200']) {
    const runId = uuid(),
      requestId = uuid(),
      source = { ...f.source, requestId, modified };
    await importer.begin({
      runId,
      deviceKey: sha('phone'),
      sources: [source],
      coverage: { enumerationComplete: true },
    });
    await importer.lookup({ runId, requestId, size: f.bytes.length, sha256: f.header.sha256 });
    assert.equal(
      (await f.library.page({ runId })).items[0].phone,
      modified === f.source.modified ? 'deleted' : 'not-requested',
    );
  }
});

test('explicit reconciliation keeps the original cleanup job identity and refuses a live worker', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-reconcile-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let active = false,
    launches = 0;
  const api = createPhoneWorkbench({
    config: { cacheRoot: dir, phoneCleanupEnabled: true },
    checkpoint,
    lock: lockCache,
    source: {},
    remote: async () => ({ confirmation: 'SUPPRIMER 1', digest: 'a'.repeat(64) }),
    launch: async () => {
      launches++;
      return 12345;
    },
    alive: async () => active,
    cleanup: async () => ({ deleted: 1, confirmedBytes: 5 }),
  });
  const requestId = uuid(),
    input = {
      op: 'start',
      requestId,
      kind: 'cleanup',
      planId: uuid(),
      confirmation: 'SUPPRIMER 1',
      digest: 'a'.repeat(64),
    };
  await api.command(input);
  active = true;
  await assert.rejects(api.command({ op: 'reconcile', requestId }), { code: 'PHONE_BUSY' });
  assert.equal(launches, 1);
  active = false;
  await api.command({ op: 'reconcile', requestId });
  assert.equal(launches, 2);
  await api.run(requestId);
  assert.equal((await api.command({ op: 'status' })).jobs[0].requestId, requestId);
  assert.equal((await api.command({ op: 'status' })).jobs[0].state, 'completed');
});

test('a partial cleanup keeps confirmed counts and fences the unresolved item', async (t) => {
  const f = await fixture(t),
    runId = uuid();
  const sources = [
    { ...f.source, requestId: uuid() },
    {
      ...f.source,
      requestId: uuid(),
      key: 'persistent-two',
      name: 'two.jpg',
      relativePath: 'Storage/DCIM/two.jpg',
    },
  ];
  const importer = await createPhotoImportService({ root: f.root });
  await importer.begin({ runId, deviceKey: sha('phone'), sources, coverage: { enumerationComplete: true } });
  for (const source of sources)
    await importer.lookup({ runId, requestId: source.requestId, size: source.size, sha256: f.header.sha256 });
  const p = await f.cleanup.prepare({ runId, planId: uuid(), items: sources.map((x) => x.requestId) });
  const dir = path.join(f.root, 'client');
  let effects = 0;
  const source = {
    devices: async () => [{ id: 'phone' }],
    inventory: async () => ({
      complete: true,
      errors: [],
      files: sources.map((x) => ({ ...x, objectId: x.requestId })),
    }),
  };
  const remove = async (request, authorize) => {
    const grant = await authorize({
      attemptId: uuid(),
      sha256: request.item.sha256,
      size: request.item.size,
    });
    effects++;
    if (effects === 2) throw Object.assign(new Error('Native result lost'), { code: 'CLEANUP_UNCERTAIN' });
    return { ...grant, state: 'deleted' };
  };
  const api = createPhoneWorkbench({
    config: { cacheRoot: dir, phoneCleanupEnabled: true },
    checkpoint,
    lock: lockCache,
    source,
    remote: transport(f),
    launch: async () => 12345,
    alive: async () => false,
    cleanup: (options) => executePhoneCleanup({ ...options, remove }),
  });
  const requestId = uuid();
  await api.command({
    op: 'start',
    kind: 'cleanup',
    requestId,
    planId: p.planId,
    digest: p.digest,
    confirmation: p.confirmation,
  });
  await api.run(requestId);
  const job = (await api.command({ op: 'status' })).jobs[0];
  assert.equal(job.state, 'unknown');
  assert.equal(job.result.deleted, 1);
  assert.equal(job.result.confirmedBytes, f.bytes.length);
  assert.equal(
    (await f.cleanup.status({ planId: p.planId })).results.filter((x) => x.state === 'uncertain').length,
    1,
  );
  const page = await f.library.page({ runId });
  assert.deepEqual(page.items.map((x) => x.phone).sort(), ['deleted', 'uncertain']);
  assert.deepEqual(await fs.readFile(f.receipt.path), f.bytes);
});

test('loss of a native cache cannot reuse an old grant with a new native attempt', async (t) => {
  const f = await fixture(t),
    p = await plan(f);
  const input = {
    planId: p.planId,
    operationId: uuid(),
    attemptId: uuid(),
    requestId: f.requestId,
    digest: p.digest,
    confirmation: p.confirmation,
    sha256: f.header.sha256,
  };
  await f.cleanup.authorize(input);
  await assert.rejects(f.cleanup.authorize({ ...input, attemptId: uuid() }), { code: 'REQUEST_CONFLICT' });
  assert.equal((await f.cleanup.status({ planId: p.planId })).results[0].state, 'uncertain');
  assert.deepEqual(await fs.readFile(f.receipt.path), f.bytes);
});
