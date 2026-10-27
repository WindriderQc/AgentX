'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createPresentationCompanion } = require('../../../src/services/conversations/presentationCompanion');
const { proposal, decisionSchema } = require('../../../src/services/conversations/presentationCompanionPolicy');
const { researchSources } = require('../../../src/services/conversations/presentationResearch');
const pages = require('../../../public/js/screen-pages').createCatalog([
  { id: 'ecosystem', label: 'Ecosystem', href: '/diskx?app=ecosystem', mode: 'frame' },
  { id: 'pipeline', label: 'Pipeline', href: '/pipeline', mode: 'frame' }
]);
const wait = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: x => resolve(x) }; };
const hit = { text: 'Core owns the shared data.', score: .9, metadata: { documentId: 'doc-alpha', source: 'manual', title: 'Shared architecture' } };
const args = { sessionId: 'personal', turnId: 'current-turn', enabled: true, frame: { text: 'Explain the shared architecture.' } };
const make = extra => createPresentationCompanion({ catalog: pages, decide: async () => ({ decision: 'keep' }), delayMs: 0, minIntervalMs: 0, ...extra });

test('research runs separately, retains exact sourced excerpts and survives public reply updates', async () => {
  const pending = deferred(), seen = [];
  const service = make({ research: () => pending.promise, decide: async frame => { seen.push(frame); return { decision: 'keep' }; } });
  try {
    const handle = service.begin(args); await service.flush();
    assert.equal(service.context('personal').research.status, 'pending');
    handle.finish(); pending.resolve([hit, hit, { text: 'Unsourced claim' }]); await wait();
    handle.append('A public reply.'); await service.flush();
    const context = service.context('personal');
    assert.equal(context.research.sources.length, 1);
    assert.equal(context.research.sources[0].excerpt, hit.text);
    assert.equal(context.research.sources[0].documentId, 'doc-alpha');
    assert.match(seen.at(-1).context, /Core owns the shared data/);
    assert.match(seen.at(-1).reply, /A public reply/);
    assert.match(service.contextFor('personal'), /collaboration_context/);
  } finally { service.close(); }
});

test('a pinned view blocks decision compute while live selection and bounded research remain available', async () => {
  let decisions = 0, reads = 0;
  const service = make({ decide: async () => { decisions++; return { decision: 'keep' }; }, research: async () => { reads++; return [hit]; } });
  try {
    service.begin({ ...args, paused: true }); await wait(); await service.flush();
    assert.equal(decisions, 0);
    assert.equal(service.observe('personal', 'older-turn', 1, { kind: 'page', selection: { id: 'wrong' } }), false);
    assert.equal(service.observe('personal', 'current-turn', 1, { kind: 'page', page: 'ecosystem', selection: { id: 'node-alpha' } }), true);
    assert.equal(service.observe('personal', 'current-turn', 1, { kind: 'page', selection: { id: 'stale' } }), false);
    await wait();
    for (let i = 2; i < 12; i++) service.observe('personal', 'current-turn', i, { kind: 'page', selection: { id: 'node-' + i } });
    await wait(); await service.flush();
    assert.equal(decisions, 0); assert.equal(reads, 2);
    assert.equal(service.context('personal').selection.selection.id, 'node-11');
    assert.equal(service.context('personal').automaticDisplay, false);
  } finally { service.close(); }
});

test('late research from a previous request cannot enter the current topic or deleted context', async () => {
  const pending = deferred(); let calls = 0;
  const service = make({ research: () => ++calls === 1 ? pending.promise : Promise.resolve([]) });
  try {
    service.begin(args); service.begin({ ...args, turnId: 'new-current-turn', frame: { text: 'A different topic.' } });
    await wait(); pending.resolve([hit]); await wait();
    assert.equal(service.context('personal').research.sources.length, 0);
    assert.equal(service.context('personal', 'current-turn').status, 'unavailable');
    service.drop('personal'); assert.equal(service.context('personal').status, 'unavailable');
  } finally { service.close(); }
});

test('review cards validate a plan and owning UI, never accept effects or arbitrary destinations', () => {
  const frame = { request: 'Prepare a proposed change for human review.' };
  const value = { decision: 'present', reason: 'Review the proposed change.', evidence: { source: 'request', quote: 'proposed change' },
    block: { kind: 'review', title: 'Proposed change', body: 'Check the target, then decide in the owning interface.', destination: 'pipeline' } };
  assert.equal(proposal(value, frame, pages).block.kind, 'review');
  assert.equal(proposal({ ...value, block: { ...value.block, execute: 'delete' } }, frame, pages), null);
  assert.equal(proposal({ ...value, block: { ...value.block, destination: 'https://external.invalid' } }, frame, pages), null);
  const Ajv = require('ajv'); const validate = new Ajv({ strict: false }).compile(decisionSchema());
  assert.equal(validate(value), true); assert.equal(validate({ ...value, block: { ...value.block, execute: 'send' } }), false);
});

test('native target grammar prevents URL-shaped pages and review destinations before generation', () => {
  const Ajv = require('ajv');
  const validate = new Ajv({ strict: false }).compile(decisionSchema(null, pages));
  const value = { decision: 'present', reason: 'Relevant existing view.', evidence: { source: 'request', quote: 'proposed change' },
    block: { kind: 'page', title: 'Ecosystem', body: 'ecosystem', focus: { play: 'network' } } };
  assert.equal(validate(value), true);
  assert.equal(proposal(value, { request: 'proposed change' }, pages).block.body, 'ecosystem play=network');
  assert.equal(proposal({ ...value, block: { ...value.block, focus: { execute: 'delete' } } }, { request: 'proposed change' }, pages), null);
  for (const body of ['ecosystem?play=overview', 'https://external.invalid', 'unknown-page'])
    assert.equal(validate({ ...value, block: { ...value.block, body } }), false);
  assert.equal(validate({ ...value, block: { kind: 'review', title: 'Review', body: 'Check first.', destination: 'pipeline' } }), true);
  assert.equal(validate({ ...value, block: { kind: 'review', title: 'Review', body: 'Check first.', destination: 'pipeline?status=review' } }), false);
});

test('source projection is bounded, deduplicated and cannot invent source identities', () => {
  const result = researchSources([hit, hit, { text: 'missing identity' }, { ...hit, text: 'x'.repeat(5000), metadata: { documentId: 'doc-beta' } }], '2026-01-01T00:00:00Z');
  assert.equal(result.length, 2); assert.equal(result[1].excerpt.length, 1200);
  assert.match(result[0].excerptSha256, /^[a-f0-9]{64}$/);
});


test('completed findings remain a bounded previous-request inbox without contaminating a new visual topic', async () => {
  let reads = 0; const pending = deferred(); let clock = Date.parse('2026-01-01T00:00:00Z');
  const service = make({ now: () => clock, research: () => ++reads === 1 ? Promise.resolve([hit]) : pending.promise });
  try {
    service.begin(args); await wait();
    service.begin({ ...args, turnId: 'next-current-turn', frame: { text: 'A different topic.' } });
    const current = service.context('personal');
    assert.equal(current.research.status, 'pending');
    assert.equal(current.research.sources.length, 0);
    assert.equal(current.previousResearch.turnId, 'current-turn');
    assert.equal(current.previousResearch.coverage, 'previous_request_only_not_current');
    assert.equal(current.previousResearch.research.sources[0].documentId, 'doc-alpha');
    clock += 300001;
    assert.equal(service.context('personal').status, 'unavailable');
    pending.resolve([]); await wait();
  } finally { service.close(); }
});


test('the empty display is explicit and native evidence choices use exact current data', () => {
  const { frameFor } = require('../../../src/services/conversations/presentationCompanionPolicy');
  const frame = frameFor({ text: 'Prepare a useful review.', screen: { status: 'none' } });
  assert.deepEqual(frame.screen, { status: 'none' });
  const Ajv = require('ajv'); const validate = new Ajv({ strict: false }).compile(decisionSchema(frame));
  const value = { decision: 'present', reason: 'Review the proposed plan.', evidence: { source: 'request', quote: frame.request },
    block: { kind: 'review', title: 'Review', body: 'Verify then decide.', destination: 'pipeline' } };
  assert.equal(validate(value), true);
  assert.equal(validate({ ...value, evidence: { source: 'request', quote: 'Invented source quotation.' } }), false);
});

test('a published current-turn proposal survives coalesced reply updates and keep until the browser can receive it', async () => {
  let calls = 0;
  const service = make({ decide: async frame => ++calls === 1 ? { decision: 'present', reason: 'Show the requested architecture.',
    evidence: { source: 'request', quote: frame.request }, block: { kind: 'page', title: 'Architecture', body: 'ecosystem' } } : { decision: 'keep' } });
  try {
    const handle = service.begin(args); await service.flush();
    const fingerprint = service.read('personal', 'current-turn').suggestion.fingerprint;
    handle.append('Public continuation.');
    assert.equal(service.read('personal', 'current-turn').state, 'ready');
    await service.flush();
    assert.equal(service.read('personal', 'current-turn').phase, 'idle');
    assert.equal(service.read('personal', 'current-turn').suggestion.fingerprint, fingerprint);
    handle.explicit(); assert.equal(service.read('personal', 'current-turn').suggestion, null);
    service.begin({ ...args, turnId: 'new-topic' }); assert.equal(service.read('personal', 'new-topic').suggestion, null);
  } finally { service.close(); }
});


test('keep carries a bounded display rationale without accepting effects or content payloads', () => {
  const frame = { request: 'Keep this view.' };
  assert.deepEqual(proposal({ decision: 'keep', reason: 'The user asked to retain the view.' }, frame, pages), { decision: 'keep', reason: 'The user asked to retain the view.' });
  assert.equal(proposal({ decision: 'keep', reason: 'x'.repeat(161) }, frame, pages), null);
  assert.equal(proposal({ decision: 'keep', execute: 'send' }, frame, pages), null);
});
