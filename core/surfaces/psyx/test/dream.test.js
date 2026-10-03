'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const { createStateRepository, emptyState } = require('../../../src/domains/psyx/stateRepository');
const { dreamMessages, readDream, portraitSystemMessage, normalizeStoredPortrait } = require('../../../src/domains/psyx/dream');
const { composeSystemContext } = require('../../../src/domains/psyx/domain');
const { createDreamer } = require('../src/dreamer');
const { createSources } = require('../src/sources');
const { createCoreProvider } = require('../src/provider');

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const statement = (text, extra = {}) => ({ text, evidence: ['« une preuve »'], confidence: 0.6, ...extra });
const DREAM = {
  portrait: { sections: [
    { key: 'loops', statements: [statement('Fatigue le soir, puis éclat, puis culpabilité.'), { text: 'Sans preuve.', evidence: [] }] },
    { key: 'situation', statements: [statement('Tu élèves seul deux enfants.')] },
    { key: 'invented', statements: [statement('Ignored section.')] }
  ] },
  findings: [{ text: 'Les éclats arrivent après 19 h.', evidence: ['trois séances'] }],
  agenda: ['Explorer les 30 secondes avant un éclat.'],
  questions: ['Comment étaient les soirées dans ton enfance?'],
  memory: [{ op: 'add', kind: 'patterns', text: 'Les éclats arrivent après 19 h.', evidence: ['trois séances'], confidence: 0.6 }]
};
const conversations = [{ id: 'c1', updatedAt: '2026-10-02T22:00:00.000Z', messages: [{ role: 'user', content: 'J’ai encore crié ce soir.' }, { role: 'assistant', content: 'Raconte.' }] }];

function groundedFixture(request) {
  const value = structuredClone(DREAM);
  const quote = request.evidenceSources[0].text.slice(0, 240);
  for (const section of value.portrait.sections) {
    for (const item of section.statements) if (item.evidence?.length) item.evidence = [quote];
  }
  for (const item of [...value.findings, ...value.memory]) item.evidence = [quote];
  return value;
}

async function harness() {
  const mongo = await MongoMemoryServer.create();
  const client = await MongoClient.connect(mongo.getUri());
  const repository = createStateRepository({ collection: client.db('psyx').collection('psyxstates'), logger: {} });
  return { repository, close: async () => { await client.close(); await mongo.stop(); } };
}

test('a dream answer becomes a portrait: fixed sections in order, no statement without evidence, nothing he rejected', () => {
  const state = { ...emptyState(), portraitRejected: ['Tu élèves seul  deux ENFANTS.'], notes: [{ id: 'mine', text: 'x', source: 'user' }, { id: 'old', text: 'y', source: 'psyx' }] };
  const dream = readDream(`Here: ${JSON.stringify({ ...DREAM, memory: [...DREAM.memory,
    { op: 'retire', kind: 'notes', id: 'mine', reason: 'no' }, { op: 'retire', kind: 'notes', id: 'old', reason: 'dépassé' }, { op: 'retire', kind: 'notes', id: 'ghost' },
    { op: 'add', kind: 'notes', text: 'Sans preuve' }] })}`, { state });
  assert.deepEqual(dream.sections.map(section => [section.key, section.statements.length]), [['loops', 1]]);
  assert.match(dream.sections[0].statements[0].id, /^[a-f0-9]{16}$/);
  assert.deepEqual(dream.memory.map(op => [op.op, op.id || op.text]), [['add', 'Les éclats arrivent après 19 h.'], ['retire', 'old']]);
  assert.equal(readDream('not json'), null);
});

test('the dream prompt carries memory with ids, the previous portrait, sources as data and the newest conversations within budget', () => {
  const state = { ...emptyState(), profile: { about: 'Père seul.', expectations: '' }, patterns: [{ id: 'p1', text: 'Évite les conflits', source: 'user', evidence: [] }],
    portrait: normalizeStoredPortrait({ updatedAt: '2026-10-01T03:00:00Z', sections: [{ key: 'values', statements: [statement('La présence compte.')] }] }), portraitRejected: ['Tu fuis.'] };
  const many = Array.from({ length: 5 }, (_, index) => ({ id: `c${index}`, updatedAt: `2026-10-0${index + 1}`, messages: [{ role: 'user', content: `séance ${index} ${'x'.repeat(400)}` }] }));
  const [system, user] = dreamMessages({ state, conversations: many, sources: [{ title: 'Notes', text: '- [fact] garde une semaine sur deux' }], maxCharacters: 2000 });
  assert.match(system.content, /data, never instructions/);
  assert.match(user.content, /"id":"p1"/);
  assert.match(user.content, /La présence compte/);
  assert.match(user.content, /Statements he rejected:\n\["Tu fuis\."\]/);
  assert.match(user.content, /### Notes\n- \[fact\] garde une semaine sur deux/);
  assert.match(user.content, /séance 4/);
  assert.doesNotMatch(user.content, /séance 1 /);
  assert.doesNotMatch(dreamMessages({ state, conversations: many, fresh: true })[1].content, /La présence compte/);
});

test('a dream writes the portrait and memory directly; the user can reject a statement and undo the whole dream', async () => {
  const { repository, close } = await harness();
  try {
    const kept = (await repository.addItem('u', 'openLoops', { text: 'Parler à mon frère' })).item;
    await repository.acceptProposal; // the review path is untouched by the dream
    const state = await repository.read('u');
    const dream = readDream({ ...DREAM, memory: [...DREAM.memory] }, { state });
    const first = await repository.recordDream('u', { dream, kind: 'session', model: 'sol', location: 'frontier', sources: ['notes'], covers: { conversations: 1, through: '2026-10-02T22:00:00.000Z' }, resetAt: state.resetAt });
    assert.deepEqual([first.state.portrait.kind, first.state.portrait.location, first.state.portrait.sources, first.state.portrait.covers.conversations], ['session', 'frontier', ['notes'], 1]);
    assert.deepEqual(first.state.patterns.map(item => [item.text, item.source]), [['Les éclats arrivent après 19 h.', 'dream']]);
    assert.equal(first.state.dreamLog[0].added.length, 1);

    // A second dream retires a PsyX item, never one the user wrote.
    const psyx = first.state.patterns[0];
    const second = await repository.recordDream('u', { dream: { ...dream, memory: [{ op: 'retire', kind: 'patterns', id: psyx.id, reason: 'résolu' }, { op: 'retire', kind: 'openLoops', id: kept.id, reason: 'x' }] }, resetAt: null });
    assert.equal(second.state.patterns[0].status, 'resolved');
    assert.equal(second.state.openLoops[0].status, 'active');
    assert.equal(second.state.portraitPrevious.id, first.state.portrait.id);

    const target = second.state.portrait.sections[0].statements[0];
    const rejected = await repository.rejectPortraitStatement('u', target.id);
    assert.equal(rejected.state.portrait.sections.some(section => section.statements.some(item => item.id === target.id)), false);
    assert.deepEqual(rejected.state.portraitRejected, [target.text]);
    assert.equal(readDream(DREAM, { state: rejected.state }).sections.some(section => section.statements.some(item => item.text === target.text)), false);

    const undone = await repository.undoDream('u', second.entry.id);
    assert.equal(undone.state.patterns[0].status, 'active');
    assert.equal(undone.state.portrait.id, first.state.portrait.id);
    await assert.rejects(repository.undoDream('u', second.entry.id), { statusCode: 404 });
    const back = await repository.undoDream('u', first.entry.id);
    assert.deepEqual([back.state.patterns.length, back.state.portrait], [0, null]);

    // A dream computed before a memory reset is discarded; a reset clears the portrait.
    const again = await repository.recordDream('u', { dream, resetAt: null });
    assert.ok(again.state.portrait);
    const reset = await repository.reset('u');
    assert.deepEqual([reset.portrait, reset.dreamLog, reset.portraitRejected], [null, [], []]);
    assert.equal((await repository.recordDream('u', { dream, resetAt: null })).skipped, 'reset');
    assert.deepEqual(await repository.dreamUserIds(), ['u']);
  } finally { await close(); }
});

test('the portrait reaches the reply inside each lane budget, agenda and questions last', () => {
  const portrait = normalizeStoredPortrait({ updatedAt: '2026-10-03T03:00:00Z', sections: [{ key: 'loops', statements: Array.from({ length: 8 }, (_, index) => statement(`Boucle ${index} ${'b'.repeat(300)}`)) }],
    findings: [{ text: 'Constat.', evidence: [] }], agenda: ['Explorer X.'], questions: ['Et ton enfance?'] });
  const state = { ...emptyState(), portrait, notes: Array.from({ length: 100 }, (_, index) => ({ text: `note ${index} ${'n'.repeat(400)}`, source: 'user', evidence: [], status: 'active' })),
    profile: { about: 'a'.repeat(3000), expectations: 'e'.repeat(1500) } };
  const control = { mode: 'talk', depth: 'normal', action: null, reason: '' };
  const local = composeSystemContext(state, control, { conversationId: 'now', voice: true, safety: { kinds: ['suicide'] }, time: { now: new Date() } });
  assert.ok(local.length < 16000, `local system context is ${local.length}`);
  assert.match(local, /PSYX PORTRAIT — your own working understanding/);
  assert.ok(portraitSystemMessage(state, { maxCharacters: 1800 }).length <= 1800);
  const small = { ...emptyState(), portrait: normalizeStoredPortrait({ updatedAt: '2026-10-03T03:00:00Z', sections: [{ key: 'values', statements: [statement('La présence compte.')] }], agenda: ['Explorer X.'], questions: ['Et ton enfance?'] }) };
  assert.match(portraitSystemMessage(small), /Values: La présence compte\.\nWorth exploring[^\n]*Explorer X\.\nGaps in your understanding[^\n]*Et ton enfance\?/);
  assert.match(portraitSystemMessage(small, { evidence: true }), /La présence compte\. \[« une preuve »\]/);
  assert.equal(portraitSystemMessage(emptyState()), '');
});

function dreamerFakes({ complete, state = emptyState(), transcripts = conversations } = {}) {
  const calls = { complete: [], recorded: [], cleared: 0 };
  return { calls,
    provider: { id: 'agentx', async complete(request) { calls.complete.push(request); return complete ? complete(request) : { content: JSON.stringify(groundedFixture(request)), model: 'sol', location: 'frontier' }; } },
    stateRepository: { read: async () => state, dreamUserIds: async () => ['u'],
      async recordDream(userId, input) { calls.recorded.push({ userId, ...input, wanted: await input.stillWanted() }); return { entry: { id: 'd1' } }; },
      async clearPortrait() { calls.cleared += 1; return { cleared: true }; } },
    conversationRepository: { listTranscripts: async () => transcripts } };
}

test('a quiet session triggers one dream; turns meanwhile queue a single follow-up; a busy user is never competed with', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let busy = true;
  const { calls, ...deps } = dreamerFakes({ complete: async request => { await gate; return { content: JSON.stringify(groundedFixture(request)), model: 'sol', location: 'frontier' }; } });
  const sources = { gather: async () => ({ sources: [{ key: 'notes', title: 'Notes', text: '- fait', count: 1 }], unavailable: ['mail'] }) };
  const dreamer = createDreamer({ ...deps, sources, config: { dream: { sessionIdleMs: 5, retryMs: 5 } }, logger: {}, isBusy: () => busy, locationFor: () => 'frontier' });
  assert.equal(dreamer.touch('u'), true);
  dreamer.touch('u');
  await tick(20);
  assert.equal(calls.complete.length, 0, 'waits while a reply streams');
  busy = false;
  await tick(20);
  assert.equal(dreamer.status('u').status, 'running');
  dreamer.touch('u');
  dreamer.touch('u');
  release();
  await tick(40);
  assert.equal(calls.complete.length, 2);
  const [request] = calls.complete;
  assert.deepEqual([request.location, request.work, request.taskType], ['frontier', 'dream', 'deep_reasoning']);
  assert.ok(request.local.messages[1].content.length <= request.messages[1].content.length);
  assert.match(request.messages[1].content, /### Notes\n- fait/);
  assert.deepEqual([calls.recorded[0].kind, calls.recorded[0].sources, calls.recorded[0].covers.conversations, calls.recorded[0].location, calls.recorded[0].wanted], ['session', ['notes'], 1, 'frontier', true]);
  assert.equal(dreamer.status('u').status, 'done');
  dreamer.stop();
});

test('the night dreams once in its hour, only when a session moved since the portrait; failures and deletions are handled', async () => {
  const portrait = normalizeStoredPortrait({ updatedAt: '2026-10-03T07:00:00Z', sections: [{ key: 'values', statements: [statement('x')] }], covers: { conversations: 1, through: '2026-10-02T22:00:00.000Z' } });
  const at = new Date('2026-10-04T07:10:00Z'); // 03:10 in America/Toronto
  const settled = dreamerFakes({ state: { ...emptyState(), portrait } });
  const quiet = createDreamer({ ...settled, config: { dream: {} }, logger: {}, now: () => at });
  await quiet.nightly();
  await tick(10);
  assert.deepEqual([settled.calls.complete.length, quiet.status('u').skipped], [0, 'unchanged']);

  const moved = dreamerFakes({ state: { ...emptyState(), portrait }, transcripts: [{ ...conversations[0], updatedAt: '2026-10-03T23:00:00.000Z' }] });
  const night = createDreamer({ ...moved, config: { dream: {} }, logger: {}, now: () => at });
  await night.nightly();
  await night.nightly();
  await tick(10);
  assert.equal(moved.calls.complete.length, 1);
  assert.equal(moved.calls.recorded[0].kind, 'night');
  const noon = createDreamer({ ...dreamerFakes(), config: { dream: {} }, logger: {}, now: () => new Date('2026-10-04T16:00:00Z') });
  await noon.nightly();
  assert.equal(noon.status('u').scheduled, false);

  const broken = dreamerFakes({ complete: async () => ({ content: '{"portrait":{"sections":[]}}' }) });
  const failing = createDreamer({ ...broken, config: { dream: { retryMs: 5 } }, logger: {} });
  failing.request('u');
  await tick(10);
  assert.deepEqual([failing.status('u').status, failing.status('u').error, broken.calls.recorded.length], ['failed', 'PSYX_DREAM_UNUSABLE', 0]);
  await failing.invalidate('u');
  assert.equal(broken.calls.cleared, 1);
  failing.stop();

  const off = createDreamer({ ...dreamerFakes(), config: { dream: { enabled: false } } });
  assert.deepEqual([off.touch('u'), off.status('u').status], [false, 'disabled']);
});

test('sources are read-only, optional and bounded; a failing one is reported, not fatal', async () => {
  const pages = [{ notes: [{ text: 'Garde une semaine sur deux', kind: 'fact', updatedAt: '2026-09-30' }], truncated: true, nextOffset: 1 }, { notes: [{ text: 'Préfère le matin', kind: 'preference', updatedAt: '2026-09-29' }], truncated: false }];
  const searches = [];
  const runtimeServices = {
    memory: { notes: { personal: () => ({ list: async ({ offset }) => pages[offset], remember() { throw new Error('never'); } }) } },
    tasks: { personal: { list: async () => { throw new Error('down'); } } }
  };
  const mailJournal = { search: async input => { searches.push(input); return { entries: [{ id: 'm1', occurredAt: '2026-10-01T10:00:00Z', counterpart: 'École', subject: 'Rencontre', summary: 'Rencontre de parents le 8.' }], truncated: false }; } };
  const { sources, unavailable } = await createSources({ runtimeServices, mailJournal, logger: {} }).gather({ now: new Date('2026-10-03T00:00:00Z') });
  assert.deepEqual(sources.map(source => [source.key, source.count]), [['notes', 2], ['mail', 1]]);
  assert.match(sources[0].text, /- \[fact, 2026-09-30\] Garde une semaine sur deux\n- \[preference, 2026-09-29\] Préfère le matin/);
  assert.match(sources[1].text, /2026-10-01 \| École \| Rencontre: Rencontre de parents le 8\./);
  assert.deepEqual(unavailable, ['tasks']);
  assert.equal(searches[0].limit, 50);
  assert.deepEqual((await createSources({}).gather()).sources, []);
});

test('a dream that falls back from the frontier lane dreams locally over the bounded material', async () => {
  const calls = [];
  const runtime = { routing: { getEffectiveSnapshot: async () => ({ tasks: {} }) }, inference: { execute: async body => { calls.push(body); return { ok: true, body: { message: { content: '{}' }, model: 'local' } }; } } };
  const seen = [];
  const down = { available: () => true, run: async input => { seen.push(input); throw Object.assign(new Error('silent'), { code: 'FRONTIER_SILENT' }); } };
  const provider = createCoreProvider(runtime, { frontier: down, config: { frontier: { agent: 'psyx', model: 'sol' } }, logger: {} });
  const result = await provider.complete({ location: 'frontier', work: 'dream', maxTurnMs: 600000, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'WIDE' }],
    local: { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'BOUNDED' }] } });
  assert.equal(seen[0].maxTurnMs, 600000);
  assert.deepEqual([calls[0].messages[1].content, calls[0].callerDetail, result.fallbackFrom], ['BOUNDED', 'psyx/dream', 'frontier']);
});

test('review findings: hostile or odd model output, rejected text anywhere, and what the user removed stay out', async () => {
  const state = { ...emptyState(), portraitRejected: ['Tu fuis les conflits.'] };
  const dream = readDream({ portrait: { sections: [{ key: 'loops', statements: [{ text: { a: 1 }, evidence: [{}] }, statement('Tu fuis les conflits'), statement('Une vraie boucle.', { evidence: [{}, 'preuve'] })] }] },
    findings: [{ text: 'tu fuis  les conflits!', evidence: ['x'] }, { text: ['array'] }, 'Un constat simple.'], agenda: [{ no: 1 }, 'Explorer.'],
    memory: [{ op: 'add', kind: 'patterns', text: 'Tu fuis les conflits.', evidence: ['x'] }, { op: 'add', kind: 'goals', text: 'Dormir avant 23 h', evidence: ['dit en séance'] }] }, { state });
  assert.deepEqual(dream.sections[0].statements.map(item => [item.text, item.evidence]), [['Une vraie boucle.', ['preuve']]]);
  assert.deepEqual([dream.findings.map(item => item.text), dream.agenda, dream.memory.map(op => op.text)], [['Un constat simple.'], ['Explorer.'], ['Dormir avant 23 h']]);

  const { repository, close } = await harness();
  try {
    for (let index = 0; index < 20; index += 1) await repository.addItem('u', 'goals', { text: `objectif ${index}` });
    const full = await repository.recordDream('u', { dream, resetAt: null });
    assert.deepEqual([full.state.goals.length, full.state.goals[0].text, full.entry.added.length], [20, 'objectif 0', 0], 'a full list is left alone');

    const add = { ...dream, memory: [{ op: 'add', kind: 'patterns', text: 'Les éclats arrivent après 19 h.', evidence: ['x'], confidence: null }] };
    const first = await repository.recordDream('u', { dream: add, resetAt: null });
    await repository.deleteItem('u', 'patterns', first.state.patterns[0].id);
    const second = await repository.recordDream('u', { dream: { ...add, memory: [{ ...add.memory[0], text: 'Les éclats arrivent après 19 h' }] }, resetAt: null });
    assert.equal(second.state.patterns.length, 0, 'what he removed is not added again, even reworded by punctuation');

    // Rejecting a statement then undoing the dream does not bring it back through the previous portrait.
    const target = second.state.portrait.sections[0].statements[0];
    const rejected = await repository.rejectPortraitStatement('u', target.id);
    assert.equal(rejected.state.portraitPrevious.sections.length, 0);
    const undone = await repository.undoDream('u', second.entry.id);
    assert.equal(JSON.stringify(undone.state.portrait).includes(target.text), false);
    // Undoing an older dream, then the newer one, never restores the undone dream's portrait.
    const a = await repository.recordDream('u', { dream: add, resetAt: null });
    const b = await repository.recordDream('u', { dream: add, resetAt: null });
    await repository.undoDream('u', a.entry.id);
    assert.equal((await repository.undoDream('u', b.entry.id)).state.portrait, null);
  } finally { await close(); }
});

test('review findings: Core dates are instants, a deletion during a dream discards it, and the frontier prompt keeps its tail', async () => {
  const dated = [['old', '2026-09-30T12:00:00Z'], ['newest', '2026-10-03T12:00:00Z'], ['mid', '2026-10-01T12:00:00Z']]
    .map(([id, at]) => ({ id, updatedAt: new Date(at), messages: [{ role: 'user', content: `séance ${id}` }] }));
  const portrait = normalizeStoredPortrait({ updatedAt: '2026-10-03T13:00:00Z', sections: [{ key: 'values', statements: [statement('x')] }], covers: { conversations: 3, through: '2026-10-03T12:00:00.000Z' } });
  const at = new Date('2026-10-04T07:10:00Z');
  const settled = dreamerFakes({ state: { ...emptyState(), portrait }, transcripts: dated });
  const night = createDreamer({ ...settled, config: { dream: {} }, logger: {}, now: () => at });
  await night.nightly();
  await tick(10);
  assert.deepEqual([settled.calls.complete.length, night.status('u').skipped], [0, 'unchanged']);

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fresh = dreamerFakes({ transcripts: dated });
  const dreamer = createDreamer({ ...fresh, config: { dream: { retryMs: 5 } }, logger: {}, sources: { gather: async () => { await gate; return { sources: [], unavailable: [] }; } } });
  dreamer.request('u');
  await tick(10);
  await dreamer.invalidate('u');
  release();
  await tick(30);
  assert.equal(fresh.calls.recorded[0].wanted, false, 'the dream that read the deleted conversation is discarded');
  assert.equal(fresh.calls.recorded.at(-1).wanted, true, 'and a new one runs');
  assert.equal(fresh.calls.recorded[0].covers.through, '2026-10-03T12:00:00.000Z');
  assert.match(fresh.calls.complete[0].messages[1].content, /séance old[\s\S]*séance mid[\s\S]*séance newest/);
  dreamer.stop();

  const { SYSTEM_PROMPT } = require('../../../src/domains/psyx/domain');
  const item = (text, size) => ({ text: `${text} ${'m'.repeat(size)}`, source: 'psyx', evidence: Array(20).fill('e'.repeat(240)), status: 'active' });
  const heavy = { ...emptyState(), profile: { about: 'a'.repeat(3000), expectations: 'e'.repeat(1500) },
    portrait: normalizeStoredPortrait({ updatedAt: '2026-10-03T03:00:00Z', sections: ['situation', 'loops', 'triggers', 'relationships', 'strengths', 'values', 'whatWorks', 'blindSpots', 'health']
      .map(key => ({ key, statements: Array.from({ length: 8 }, (_, index) => ({ text: `${key} ${index} ${'s'.repeat(480)}`, evidence: Array(4).fill('p'.repeat(240)) })) })) }) };
  for (const key of ['notes', 'patterns', 'hypotheses', 'openLoops', 'activeThreads']) heavy[key] = Array.from({ length: 60 }, (_, index) => item(`${key} ${index}`, 450));
  const wide = composeSystemContext(heavy, { mode: 'talk', depth: 'normal', action: null, reason: '' }, { conversationId: 'now', budget: 'frontier', safety: { kinds: ['suicide'] }, voice: true, time: { now: new Date() } });
  assert.ok(wide.length < 58000, `frontier system context is ${wide.length}`);
  assert.ok(wide.length > SYSTEM_PROMPT.length + 30000);
});

test('the dream routes sit behind the session and reach the store', async () => {
  const { createApp } = require('../src/app');
  const calls = [];
  const state = emptyState();
  const database = { ping: async () => true, conversationRepository: {},
    stateRepository: { read: async () => state, undoDream: async (userId, id) => { calls.push(['undo', userId, id]); return { state }; },
      rejectPortraitStatement: async (userId, id) => { calls.push(['reject', userId, id]); return { state }; } } };
  const dreamer = { status: () => ({ enabled: true, status: 'idle' }), request: userId => { calls.push(['run', userId]); return true; }, touch() {}, invalidate: async () => {} };
  const config = { env: 'test', accessMode: 'token', accessToken: 'secret-token-for-tests', loopbackBypass: false, sessionTtlMs: 3600000, maxBodyBytes: 65536, requestTimeoutMs: 1000, voice: { mode: 'disabled' }, frontier: {} };
  const app = createApp({ config, database, provider: { id: 'x', probe: async () => ({}) }, logger: {}, dreamer, reviewer: { status: () => ({}), schedule: () => false } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/psyx`;
  try {
    assert.equal((await fetch(`${base}/dream/status`)).status, 401);
    assert.equal((await fetch(`${base}/dream/run`, { method: 'POST' })).status, 401);
    const headers = { Authorization: 'Bearer secret-token-for-tests' };
    assert.equal((await (await fetch(`${base}/dream/status`, { headers })).json()).data.status, 'idle');
    assert.equal((await fetch(`${base}/dream/run`, { method: 'POST', headers })).status, 202);
    assert.equal((await fetch(`${base}/dream/d1/undo`, { method: 'POST', headers })).status, 200);
    assert.equal((await fetch(`${base}/portrait/statements/s1`, { method: 'DELETE', headers })).status, 200);
    assert.deepEqual(calls.map(call => call[0]), ['run', 'undo', 'reject']);
    assert.equal(calls[1][2], 'd1');
  } finally { server.close(); }
});
