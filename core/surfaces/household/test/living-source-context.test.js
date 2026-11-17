'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { livingSourceContext, MAX_CONTEXT_CHARS } = require('../living-source-context');
const family = { pack: { id: 'kidx_nestor', childSafe: true }, session: { scopeId: 'family' }, familyPackId: 'kidx_nestor' };
const owner = { ...family, pack: { id: 'personal_operator', childSafe: false }, session: { scopeId: 'personal' } };
const weather = { fetchedAt: new Date().toISOString(), temperatureC: 0, privateData: 'secret-sentinel' };
function deps(calls = []) {
  return { ambient: { weather: async () => weather, snapshot: () => { throw Error('must not read operations'); } },
    sources: { forAudience: (audience, options) => {
      calls.push(audience); assert.equal(typeof options.ambient.weather, 'function');
      return { catalogue: () => ({ sources: audience === 'owner' ? ['weather', 'agentx', 'secretary', 'comptable'] : ['weather', 'agentx'] }),
        read: () => { throw Error('catalogue must not trigger a source read'); } };
    } } };
}
test('accepted family and owner sessions receive their complete catalogue and the same safe dated weather', async () => {
  const calls = [];
  const child = await livingSourceContext({ ...family, ...deps(calls), backend: 'openclaw' });
  const adult = await livingSourceContext({ ...owner, ...deps(calls), backend: 'hermes' });
  assert.deepEqual(calls, ['household', 'owner']);
  assert.doesNotMatch(child, /secretary|comptable|secret-sentinel/);
  assert.match(adult, /secretary/);
  for (const context of [child, adult]) {
    assert.match(context, /"temperatureC":0/); assert.match(context, /retrieval timestamp/);
    assert.match(context, /only if the runtime actually offers/);
    assert.doesNotMatch(context, /secret-sentinel/);
  }
});
test('guardian and inference never claim catalogue tools are installed', async () => {
  const guardian = await livingSourceContext({ ...owner, ...deps(), backend: 'openclaw', guardian: true });
  assert.match(guardian, /tool-free guardian/); assert.match(guardian, /Do not start a second consultation/);
  const local = await livingSourceContext({ ...family, ...deps(), backend: 'agentx' });
  assert.match(local, /explicitly offered tools/); assert.match(local, /does not install source tools/);
});
test('reader, team member, consultation, wrong owner scope and LLMx get no source context or reads', async () => {
  for (const options of [{ ...family, pack: { id: 'kidx_reader', childSafe: true } }, { ...owner, member: {} },
    { ...owner, consult: true }, { ...owner, session: { scopeId: 'family' } }, { ...family, isLlmX: true }]) {
    const calls = [];
    assert.equal(await livingSourceContext({ ...options, ...deps(calls) }), '');
    assert.deepEqual(calls, []);
  }
});
test('oversized catalogue fails explicitly rather than delivering silent truncation', async () => {
  await assert.rejects(livingSourceContext({ ...family, ambient: { weather: async () => weather },
    sources: { forAudience: () => ({ catalogue: () => ({ title: 'x'.repeat(MAX_CONTEXT_CHARS) }) }) } }),
  { code: 'LIVING_SOURCE_CONTEXT_TOO_LARGE' });
});


test('Family keeps the existing compact catalogue while owner retains detailed guidance', async () => {
  const sources = require('../../../src/services/livingSourceService');
  const ambient = { weather: async () => weather };
  const fullFamily = sources.forAudience('household', { ambient }).catalogue();
  const fullOwner = sources.forAudience('owner', { ambient }).catalogue({ ownerSections: false });
  const catalogueFrom = text => JSON.parse(text.split('Core living-source catalogue (metadata, not live results): ')[1].split('\n')[0]);
  const child = catalogueFrom(await livingSourceContext({ ...family, ambient, sources, backend: 'agentx' }));
  const adult = catalogueFrom(await livingSourceContext({ ...owner, ambient, sources, backend: 'hermes' }));
  const { reading, ...expected } = fullFamily;
  expected.sources = fullFamily.sources.map(({ answers, notFor, ...source }) => source);
  assert.deepEqual(child, expected);
  assert.deepEqual(adult, fullOwner);
  assert.deepEqual(child.sources.map(row => row.source), ['weather', 'agentx']);
  assert.equal(child.reading, undefined);
  assert.ok(adult.reading.timestamps);
  assert.ok(adult.sources.every(row => row.answers && row.notFor));
  assert.ok(JSON.stringify(child).length < JSON.stringify(fullFamily).length);
});

test('explicit forecast catalogue additions do not enter automatic context', async () => {
  const sources = require('../../../src/services/livingSourceService');
  assert.deepEqual(sources.forAudience('owner').catalogue().sources[0].sections, ['forecasts', 'hourly', 'warnings']);
  const text = await livingSourceContext({ ...owner, ambient: { weather: async () => weather }, sources });
  assert.doesNotMatch(text, /"sections":\["forecasts"/);
});
