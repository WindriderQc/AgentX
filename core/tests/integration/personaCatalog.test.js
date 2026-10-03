'use strict';
const express = require('express');
const request = require('supertest');
const PromptConfig = require('../../models/PromptConfig');
const catalog = require('../../src/services/personaCatalog');
const app = express();
app.use(express.json());
app.use('/api/prompts', require('../../routes/prompts'));

describe('shared versioned persona catalog', () => {
  const definition = { name: 'catalog_test_persona', systemPrompt: 'An original character.',
    description: 'A conversational persona', uiConfig: { type: 'chat', route: '/index.html',
      layoutConfig: { label: 'Example', voice: { provider: 'kokoro', presentation: 'masculine', voices: { en: 'am_michael' } }, visual: { actorId: 'example' } } } };
  beforeEach(async () => { await PromptConfig.deleteMany({ name: { $in: ['catalog_test_persona', 'agent_catalog_test', 'catalog_test_app', 'catalog_test_inactive'] } }); });
  afterAll(async () => { await PromptConfig.deleteMany({ name: { $in: ['catalog_test_persona', 'agent_catalog_test', 'catalog_test_app', 'catalog_test_inactive'] } }); });

  test('publishes idempotently, versions changes, and resolves the old persona exactly', async () => {
    await catalog.publish('test-source', [definition]);
    await catalog.publish('test-source', [definition]);
    expect(await PromptConfig.countDocuments({ name: definition.name })).toBe(1);
    const original = await catalog.resolve(definition.name);
    await catalog.publish('test-source', [{ ...definition, systemPrompt: 'A revised character.' }]);
    const current = await catalog.resolve(definition.name);
    expect(current.version).toBe(2);
    expect(current.uiConfig.layoutConfig.voice.voices.en).toBe('am_michael');
    expect(current.uiConfig.layoutConfig.visual.actorId).toBe('example');
    expect((await catalog.resolve(definition.name, 1)).systemPrompt).toBe(original.systemPrompt);
    const response = await request(app).get('/api/prompts/catalog');
    expect(response.status).toBe(200);
    expect(response.body.data.filter(p => p.name === definition.name).map(p => p.version)).toEqual([2]);
  });

  test('a generated persona cannot be overwritten by another source or the prompt editor', async () => {
    await catalog.publish('test-source', [definition]);
    await expect(catalog.publish('another-source', [definition])).rejects.toMatchObject({ statusCode: 409 });
    const response = await request(app).post('/api/prompts').send({ name: definition.name, systemPrompt: 'Conflicting copy' });
    expect(response.status).toBe(409);
    expect(await PromptConfig.countDocuments({ name: definition.name })).toBe(1);
  });

  test('workflow prompts, independent applications and inactive drafts remain outside the picker', async () => {
    await PromptConfig.create([
      { name: 'agent_catalog_test', systemPrompt: 'Workflow', isActive: true },
      { name: 'catalog_test_app', systemPrompt: 'Application', isActive: true, uiConfig: { type: 'chat', route: '/separate-app' } },
      { name: 'catalog_test_inactive', systemPrompt: 'Draft', isActive: false }
    ]);
    expect((await catalog.list()).filter(p => ['agent_catalog_test', 'catalog_test_app', 'catalog_test_inactive'].includes(p.name))).toEqual([]);
    expect(await PromptConfig.countDocuments({ name: 'agent_catalog_test' })).toBe(1);
    await expect(catalog.resolve('agent_catalog_test')).rejects.toMatchObject({ statusCode: 404 });
    await expect(catalog.resolve(definition.name, { $gt: 0 })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('the instance edits a generated persona, the source stops regenerating it, and a reset returns to the default', async () => {
    await catalog.publish('test-source', [definition]);
    const edited = await request(app).put(`/api/prompts/catalog/${definition.name}`).send({ label: 'Renamed', personality: 'A rewritten character.',
      voice: { provider: 'kokoro', voices: { fr: 'ff_siwis' } }, visual: { style: 'orb', color: '#AA33CC' } });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ version: 2, systemPrompt: 'A rewritten character.', isActive: true });
    const layout = (await catalog.resolve(definition.name)).uiConfig.layoutConfig;
    expect(layout).toMatchObject({ label: 'Renamed', visual: { actorId: 'example', style: 'orb', color: '#aa33cc' },
      voice: { provider: 'kokoro', presentation: 'masculine', voices: { fr: 'ff_siwis' }, source: 'team' }, source: { id: 'test-source', edited: true } });
    // The source publishes again, even with a changed definition: the instance version stays.
    await catalog.publish('test-source', [{ ...definition, systemPrompt: 'A newer default.' }]);
    expect((await catalog.resolve(definition.name)).systemPrompt).toBe('A rewritten character.');
    expect((await catalog.resolve(definition.name, 1)).systemPrompt).toBe('An original character.');

    const reset = await request(app).delete(`/api/prompts/catalog/${definition.name}/edit`);
    expect(reset.status).toBe(200);
    expect(reset.body.data).toMatchObject({ version: 3, systemPrompt: 'An original character.' });
    expect(reset.body.data.uiConfig.layoutConfig.source.edited).toBeUndefined();
    await catalog.publish('test-source', [{ ...definition, systemPrompt: 'A newer default.' }]);
    expect((await catalog.resolve(definition.name)).systemPrompt).toBe('A newer default.');
  });

  test('a persona edit is validated and only reaches generated personas', async () => {
    await catalog.publish('test-source', [definition]);
    for (const body of [{ label: '' }, { label: 'two\nlines' }, { voice: { provider: 'unknown', voices: { fr: 'x' } } },
      { voice: { provider: 'kokoro', voices: {} } }, { visual: { style: 'orb', color: 'red' } }, { personality: 'x'.repeat(12001) }]) {
      expect((await request(app).put(`/api/prompts/catalog/${definition.name}`).send(body)).status).toBe(400);
    }
    expect(await PromptConfig.countDocuments({ name: definition.name })).toBe(1);
    await PromptConfig.create({ name: 'agent_catalog_test', systemPrompt: 'Workflow', isActive: true });
    expect((await request(app).put('/api/prompts/catalog/agent_catalog_test').send({ label: 'Nope' })).status).toBe(409);
    expect((await request(app).put('/api/prompts/catalog/catalog_test_missing').send({ label: 'Nope' })).status).toBe(404);
  });
});
