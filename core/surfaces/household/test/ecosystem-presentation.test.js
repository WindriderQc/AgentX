'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const vm = require('node:vm');
const fs = require('node:fs');
const pages = require('../../../public/js/screen-pages');
const { screenDestinations } = require('../../../../shared/screenDestinations');
const { createPresentationReader, PRESENTATION_TOOL_HANDLERS } = require('../../../src/services/presentationReadService');
const { FRESH_MS } = require('../../../src/services/ecosystemPresentation');
const { presentationEvidence, screenContext } = require('../screen-context');
const { requestsScreenVisit } = require('../screen-services');
const { createReplyChannels, contract } = require('../reply-channels');
const diskx = require('../../diskx');
const catalog = pages.createCatalog(screenDestinations({ agentxProfile: 'full' }));
const ID = 'synthetic-card';
const INSTANCE = '11111111-1111-4111-8111-111111111111';
function observation(at, extra = {}) {
  return { application: 'ecosystem', presentationId: ID, instance: INSTANCE, sequence: 1,
    version: 'a'.repeat(64), documentRevision: 1, snapshot: '2030-01-02', mountedAt: new Date(at - 1000).toISOString(), observedAt: new Date(at).toISOString(),
    tour: { script: 'memory,garage', index: 0, count: 2, kind: 'memory', label: 'Mémoire', title: 'Données', playing: false, adhoc: null },
    focus: [{ id: 'collector', label: 'Collecteur' }, { id: 'archive', label: 'Archive' }], selection: null,
    narration: 'Les événements sont collectés puis archivés.', narrationComplete: true, ...extra };
}
function selected(at, extra = {}) {
  const value = observation(at, extra);
  value.tour = { ...value.tour, adhoc: 'node-collector', kind: 'node', title: 'Collecteur' };
  value.selection = { id: 'collector', label: 'Collecteur', description: 'Collecte les événements synthétiques et les transmet à l’archive.' };
  return value;
}

test('the catalogue opens the existing tour using the existing DiskX route and relay, without reading Data', async () => {
  const target = catalog.parse('ecosystem play=memory,garage');
  const url = new URL(catalog.url(target), 'https://core.test');
  assert.equal(url.pathname, '/diskx'); assert.equal(url.searchParams.get('app'), 'ecosystem');
  assert.equal(url.searchParams.get('play'), 'memory,garage'); assert.equal(catalog.mode(target), 'frame');
  assert.equal(diskx.checkQuery(Object.fromEntries(url.searchParams)).play, 'memory,garage');
  assert.equal(catalog.parse('ecosystem play=delete'), null);
  assert.equal(catalog.parse('ecosystem url=https://arbitrary.invalid'), null);
  assert.equal(pages.createCatalog(screenDestinations({ agentxProfile: 'demo' })).parse('ecosystem'), null);
  assert.equal(requestsScreenVisit('Montre-moi où passent les données', catalog), true);
  assert.equal(requestsScreenVisit('Montre-moi une photo', catalog), false);
  const app = express();
  diskx.register({ app, express, env: {}, fetchData: async () => assert.fail('An ecosystem visit never reads or scans the datalake') });
  const answer = await request(app).get(url.pathname + url.search + '&presentation=' + ID).expect(200);
  assert.match(answer.text, /<agentx-ecosystem/); assert.match(answer.text, /presentation-id="synthetic-card"/);
  assert.match(answer.text, /src="\/api\/diskx\/diskx.js"/); assert.doesNotMatch(answer.text, /<diskx-city/);
  for (const query of ['group=' + 'a'.repeat(64), 'janitor=latest', 'focus=/data', 'presentation=https://elsewhere.test'])
    await request(app).get('/diskx?app=ecosystem&' + query).expect(400);
});

test('a rendered observation is a versioned browser receipt, not a Core inventory or opening intention', () => {
  let now = Date.now(); const reader = createPresentationReader({ now: () => now });
  const read = reader.observeEcosystem(observation(now), ID);
  assert.equal(read.status, 'available'); assert.equal(read.observationOwner, 'browser_after_render');
  assert.equal(read.instance, INSTANCE); assert.equal(read.version, 'a'.repeat(64));
  assert.equal(read.selection.status, 'ambiguous'); assert.equal(read.selection.clarificationRequired, true);
  assert.deepEqual(read.selection.candidates.map(row => row.id), ['collector', 'archive']);
  assert.match(read.limits.join(' '), /not live telemetry/);
  read.selection.candidates[0].label = 'A caller cannot mutate the retained receipt';
  assert.equal(reader.read(read).selection.candidates[0].label, 'Collecteur');
  assert.equal(reader.observeEcosystem(observation(now), ID).status, 'available', 'the caller cannot corrupt same-frame replay validation');
  assert.equal(PRESENTATION_TOOL_HANDLERS.read_presentation(read, { presentationReader: reader }).tour.kind, 'memory');
  now += FRESH_MS + 1;
  assert.equal(reader.read(read).status, 'unavailable');
  assert.equal(reader.observeEcosystem(observation(now - FRESH_MS - 1), ID).reason, 'stale_display_observation');
});

test('a newer selected component supersedes earlier frames; instance, version and sequence mismatches are refused', () => {
  let now = Date.now(); const reader = createPresentationReader({ now: () => now });
  const first = observation(now), opened = reader.observeEcosystem(first, ID);
  now += 100;
  const second = selected(now, { mountedAt: first.mountedAt, sequence: 2 });
  const shown = reader.observeEcosystem(second, ID);
  assert.equal(shown.selection.id, 'collector'); assert.match(shown.selection.description, /archive/);
  assert.equal(reader.read(opened).reason, 'superseded_display_observation');
  assert.equal(reader.observeEcosystem(first, ID).reason, 'superseded_display_observation');
  assert.equal(reader.observeEcosystem({ ...second, version: 'b'.repeat(64) }, ID).reason, 'display_version_mismatch');
  assert.equal(reader.observeEcosystem({ ...second, sequence: 2, narration: 'Different same-sequence content' }, ID).reason, 'display_revision_reused');
  assert.equal(reader.observeEcosystem(second, 'another-card').reason, 'presentation_instance_mismatch');
  now += 100;
  const replacement = observation(now, { instance: '22222222-2222-4222-8222-222222222222', mountedAt: new Date(now).toISOString() });
  assert.equal(reader.observeEcosystem(replacement, ID).status, 'available');
  assert.equal(reader.read(shown).status, 'unavailable');
  assert.equal(reader.observeEcosystem({ ...second, observedAt: new Date(now).toISOString(), sequence: 3 }, ID).reason, 'superseded_display_instance');
});

test('malformed, future, unversioned and inconsistent browser observations never receive a read reference', () => {
  const now = Date.now(), reader = createPresentationReader({ now: () => now });
  for (const extra of [
    { version: null }, { instance: 'not-an-instance' }, { documentRevision: -1 }, { sequence: 0 },
    { observedAt: new Date(now + 6000).toISOString() }, { mountedAt: new Date(now + 1).toISOString() },
    { tour: { ...observation(now).tour, count: 99 } }, { tour: { ...observation(now).tour, kind: 'garage' } },
    { focus: Array(33).fill({ id: 'collector', label: 'Collecteur' }) }, { narration: 'x'.repeat(4001) },
    { selection: { id: 'unseen', label: 'Unseen', description: 'Not displayed' } }
  ]) assert.equal(reader.observeEcosystem(observation(now, extra), ID).status, 'unavailable', JSON.stringify(extra));
  const value = observation(now, { password: 'DO_NOT_COPY', bodyHtml: '<script>DO_NOT_COPY</script>' });
  assert.doesNotMatch(JSON.stringify(reader.observeEcosystem(value, ID)), /DO_NOT_COPY/);
});

test('the next turn receives only the selected, fresh instance; loading and stale inputs cannot be described as displayed', () => {
  const now = Date.now();
  const row = { contract: 'agentx.presentation/v1', id: ID, revision: ID, kind: 'page', title: 'Tour', page: 'ecosystem play=memory,garage', status: 'loading' };
  assert.equal(presentationEvidence([row], catalog).read, undefined);
  const input = [{ ...row, status: 'visible', observation: selected(now) }];
  const evidence = presentationEvidence(input, catalog);
  assert.equal(evidence.read.status, 'available'); assert.equal(evidence.selection.id, 'collector');
  const context = screenContext(input, catalog, evidence);
  assert.match(context, /browser_after_render/); assert.match(context, /Collecte les événements/);
  assert.match(context, /"instance":"11111111/); assert.match(context, /"version":"aaaaaaaa/);
  assert.equal(presentationEvidence([{ ...row, status: 'visible', observation: observation(now - FRESH_MS - 1) }], catalog).status, 'unavailable');
  assert.equal(presentationEvidence([], catalog).status, 'none');
});

test('the page adapter cannot turn an early ready event into a rendered receipt, and closing clears it', () => {
  const events = {}; let displayed = null;
  const view = { state: () => displayed, addEventListener: (name, fn) => { events[name] = fn; } };
  const window = { customElements: { get: () => true } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../diskx/public/ecosystem-page.js'), 'utf8'), {
    window, document: { querySelector: () => view, getElementById: () => ({ classList: { add() {} } }) }, setTimeout() {}
  });
  assert.equal(window.AgentXPresentedContent.state, 'loading');
  events['ecosystem-ready'](); assert.equal(window.AgentXPresentedContent.state, 'loading');
  displayed = { presentation: selected(Date.now()) };
  assert.equal(window.AgentXPresentedContent.state, 'ready');
  events['ecosystem-closed'](); assert.equal(window.AgentXPresentedContent.state, 'unavailable');
  assert.equal(window.AgentXPresentedContent.observation, undefined);
});

test('the shared native response contract opens the tour and requires clarification for an ambiguous follow-up', () => {
  const instructions = contract({ pages: true, pageCatalog: catalog });
  assert.match(instructions, /ecosystem play=frank,memory,garage/);
  assert.match(instructions, /Opening is an intention/);
  assert.match(instructions, /ambiguous or absent, ask which component/);
  assert.match(contract({ pages: true, family: true, pageCatalog: catalog }), /ecosystem play=/);
  const shown = [], channels = createReplyChannels({ allowPages: true, pageCatalog: catalog, onShow: block => shown.push(block) });
  channels.push('Je t’ouvre la visite des données.<show kind="page" title="Visite">ecosystem play=memory,garage</show>');
  channels.end();
  assert.equal(shown[0].kind, 'page'); assert.equal(shown[0].body, 'ecosystem play=memory,garage');
});

test('two simulated native Main turns retain the opening and consume the actual selected-component context', async () => {
  const { nativeWorkRuntime } = require('../native-work-runtime');
  const { readTurnContext } = require('../../../src/services/conversations/turnContext');
  const { hash } = require('../../../src/services/conversationWorks/contract');
  const first = 'Montre-moi où passent les données', second = 'Et ce composant sert à quoi ?';
  const turns = [{ traceId: 'first', inputText: first, attachments: [] }], sent = [];
  const conversations = { getTurn: async () => turns.at(-1), readTurns: async () => turns };
  const runtime = nativeWorkRuntime({ screenPages: catalog, conversations,
    works: { query: sessionId => ({ sessionId }), conversationContext: sessionId => readTurnContext(conversations, { sessionId }) },
    continuity: async () => ({ capabilities: { isolatedWork: true, nativeConversation: true } }),
    agentClient: async input => { sent.push(input); return { text: input.text === first
      ? 'Je t’ouvre le parcours des données.<show kind="page">ecosystem play=memory,garage</show>'
      : 'Le collecteur transmet les événements à l’archive.' }; } });
  const session = { sessionId: 'synthetic-owner-session', packId: 'personal_operator', scopeId: 'personal', persona: {} };
  const prepare = selectedContext => runtime.prepare({ row: { mode: 'native', sessionId: session.sessionId,
    turnId: turns.at(-1).traceId, requestSha256: hash(turns.at(-1).inputText), attempt: { sessionId: 'isolated-attempt', agentId: 'main' } }, session, selectedContext });
  const opened = await runtime.execute(await prepare('No presentation is selected.'));
  const channels = createReplyChannels({ allowPages: true, pageCatalog: catalog }); channels.push(opened.text);
  const content = channels.end();
  assert.equal(content.display[0].body, 'ecosystem play=memory,garage');
  turns[0].replyText = content.say; turns[0].display = content.display;
  turns.push({ traceId: 'second', inputText: second, attachments: [] });
  const row = { contract: 'agentx.presentation/v1', id: 'two-turn-card', revision: 'two-turn-card', kind: 'page',
    page: 'ecosystem play=memory,garage', status: 'visible', observation: selected(Date.now(), { presentationId: 'two-turn-card' }) };
  const evidence = presentationEvidence([row], catalog);
  const prepared = await prepare(screenContext([row], catalog, evidence));
  await runtime.execute(prepared);
  assert.equal(sent.length, 2); assert.equal(sent[1].text, second);
  assert.match(sent[1].turnContext, /Montre-moi où passent les données/);
  assert.match(sent[1].turnContext, /"id":"collector"/);
  assert.match(sent[1].turnContext, /Collecte les événements synthétiques/);
  assert.match(sent[1].turnContext, /"instance":"11111111/);
  assert.match(sent[1].instructions, /ambiguous or absent, ask which component/);
  assert.equal(sent[1].session.agentId, 'main');
});
