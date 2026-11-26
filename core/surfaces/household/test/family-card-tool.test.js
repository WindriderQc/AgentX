'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./fixtures/persona-journey.cjs');
const { familyToolset } = require('../family-tools');

const env = { HOUSEHOLD_FAMILY_TOOLS: 'family_cards_read' };
const call = section => ({ function: { name: 'family_cards_read', arguments: { section } } });

function household() {
  const reads = [];
  return { reads, familyTasks: {
    listProfiles: async () => { reads.push('profiles'); return { profiles: [{ id: 'a', displayName: 'Alex' }] }; },
    room: async ({ profileId }) => {
      reads.push(profileId);
      return { room: { available: [{ title: 'Ranger le jeu', dueToday: true }], waiting: [{ title: 'Plier le linge' }], completedToday: 2 } };
    },
    listProfileDetails: () => assert.fail('Adult profile details')
  }, plants: { list: async input => {
    assert.deepEqual(input, { view: 'child' }); reads.push('plants');
    return { plants: [{ nickname: 'Feuille', needs: { water: 'Lundi' }, doNotEat: false,
      draftNotes: 'private-marker', toxicity: { children: 'unknown' } }] };
  } } };
}

test('Bonjour skips card reads, then the local model selects and receives just the requested section', async () => {
  const services = household();
  const h = harness({ ...services, packId: 'kidx_nestor', backend: 'agentx', conversationEnv: env,
    response: body => {
      const last = body.messages.at(-1);
      if (last.role === 'tool') return 'Ranger le jeu.';
      if (last.content.includes('Les corvées du jour')) return { message: { content: '', tool_calls: [call('chores')] } };
      return 'Bonjour !';
    } });
  await h.turn('Bonjour !', 'text');
  assert.deepEqual(services.reads, []);
  assert.deepEqual(h.sent[0].tools.map(tool => tool.function.name), ['family_cards_read']);
  assert.doesNotMatch(h.sent[0].request, /Ranger le jeu|Feuille/);
  await h.turn('Les corvées du jour, s’il te plaît.', 'text');
  assert.deepEqual(services.reads, ['profiles', 'a']);
  const result = JSON.parse(h.sent.at(-1).messages.find(message => message.role === 'tool').content);
  assert.deepEqual(result.items.map(row => row.kind), ['room', 'chore', 'chore']);
  assert.equal(result.items[0].approvedToday, 2);
  assert.deepEqual(result.items.slice(1).map(row => row.status), ['available', 'waiting_for_parent']);
  assert.equal(h.turns[0].toolEvidence.receipts[0].status, 'completed');
});

test('the plant read uses published cards, protects unknown toxicity, and distinguishes empty from unavailable', async () => {
  const services = household();
  const tools = familyToolset(env, { toolDeps: { familyCards: services } });
  const first = await tools.execute(call('plants'));
  assert.deepEqual(services.reads, ['plants']);
  assert.doesNotMatch(first.message.content, /private-marker|draftNotes/);
  assert.deepEqual(JSON.parse(first.message.content).items[0], { nickname: 'Feuille', needs: { water: 'Lundi' },
    toxicity: { children: 'unknown', pets: 'unknown' } });
  services.plants.list = async () => ({ plants: [] });
  const empty = await tools.execute(call('plants'));
  assert.equal(empty.receipt.status, 'completed');
  assert.deepEqual(JSON.parse(empty.message.content).items, []);
  services.plants.list = async () => { throw Error('private-error'); };
  const failed = await tools.execute(call('plants'));
  assert.equal(failed.receipt.error, 'FAMILY_CARDS_UNAVAILABLE');
  assert.doesNotMatch(failed.message.content, /private-error|"items"/);
  const invalid = await tools.execute({ function: { name: 'family_cards_read', arguments: { section: 'plants', view: 'manage' } } });
  assert.equal(invalid.receipt.error, 'INVALID_ARGUMENTS');
  assert.equal(familyToolset(env), null);
});

test('private turn preferences and ephemeral turns withhold cards, while an installation without the grant retains summaries', async () => {
  for (const restricted of ['preferences', 'ephemeral', 'legacy']) {
    const services = household();
    const h = harness({ ...services, packId: 'kidx_nestor', backend: 'agentx',
      conversationEnv: restricted === 'legacy' ? {} : env,
      preferencesFor: () => ({ read: async () => ({ values: { householdContext: restricted !== 'preferences' } }) }) });
    if (restricted === 'ephemeral') h.session.ephemeral = true;
    await h.turn('Bonjour', 'text');
    assert.equal(h.sent[0].tools?.some(tool => tool.function.name === 'family_cards_read') || false, false);
    if (restricted === 'legacy') {
      assert.deepEqual(services.reads, ['profiles', 'a', 'plants']);
      assert.match(h.sent[0].request, /Ranger le jeu/);
      assert.match(h.sent[0].request, /Feuille/);
    } else {
      assert.deepEqual(services.reads, []);
      assert.doesNotMatch(h.sent[0].request, /Ranger le jeu|Feuille/);
    }
  }
});

test('a grant for Family leaves Reader, the native family agent and the guardian catalogue unchanged', async () => {
  const readerSources = household();
  const reader = harness({ ...readerSources, packId: 'kidx_reader', backend: 'agentx', conversationEnv: env });
  await reader.turn('Bonjour', 'text');
  assert.deepEqual(readerSources.reads, []);
  assert.equal(reader.sent[0].tools, undefined);

  const nativeSources = household();
  const native = harness({ ...nativeSources, packId: 'kidx_nestor', backend: 'openclaw', conversationEnv: env });
  await native.turn('Bonjour', 'text');
  assert.deepEqual(nativeSources.reads, ['profiles', 'a', 'plants']);
  assert.match(native.sent[0].request, /Ranger le jeu/);
  assert.doesNotMatch(native.sent[0].prefix, /family_cards_read/);

  const guardian = require('../guardian-read-tools').forTurn({ ...env, HOUSEHOLD_GUARDIAN_TOOLS: 'math' },
    { backend: 'agentx', packId: 'kidx_nestor' });
  assert.deepEqual(guardian.names, ['math']);
  assert.equal(guardian.accept(call('chores')), null);
});

test('a large collection of child cards stays readable through the recorded next offset', async () => {
  const cards = Array.from({ length: 8 }, (_, i) => ({ nickname: 'Plante ' + i, needs: { light: 'L'.repeat(800), water: 'E'.repeat(800) } }));
  const tools = familyToolset(env, { toolDeps: { familyCards: { plants: { list: async () => ({ plants: cards }) } } } });
  const seen = [];
  let offset = 0;
  do {
    const reply = await tools.execute({ function: { name: 'family_cards_read', arguments: { section: 'plants', offset } } });
    assert.equal(reply.receipt.status, 'completed');
    assert.ok(reply.message.content.length <= 8000);
    const page = JSON.parse(reply.message.content);
    assert.equal(page.totalRows, cards.length);
    assert.ok(page.nextOffset === null || page.nextOffset > offset);
    seen.push(...page.items.map(item => item.nickname));
    offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(seen, cards.map(card => card.nickname));
});
