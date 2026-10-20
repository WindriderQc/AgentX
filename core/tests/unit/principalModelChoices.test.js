'use strict';

const PrincipalModelChoices = require('../../models/PrincipalModelChoices');
const RouterTaskConfig = require('../../models/RouterTaskConfig');
const choices = require('../../src/services/principalModelChoices');

afterEach(async () => {
  await Promise.all([PrincipalModelChoices.deleteMany({}), RouterTaskConfig.deleteMany({})]);
});

describe('principal model choices', () => {
  test('an install keeps the models it ran, read once', async () => {
    await RouterTaskConfig.create({ taskType: 'daily_operator', model: 'open:27b', host: 'primary' });
    const env = { AGENTX_DAILY_OPERATOR_MODEL: 'everyday:27b', HOUSEHOLD_PERMISSIVE_PRIMARY_MODEL: 'ignored:27b' };
    expect(await choices.getChoices({ env, pinnedModel: 'open:27b' })).toMatchObject({
      standard: 'everyday:27b', abliterated: 'open:27b', revision: 0, source: 'migrated'
    });
    // Later env changes no longer reach the stored choices.
    expect(await choices.getChoices({ env: { AGENTX_DAILY_OPERATOR_MODEL: 'changed:7b' } }))
      .toMatchObject({ standard: 'everyday:27b', abliterated: 'open:27b' });
    expect(await PrincipalModelChoices.countDocuments()).toBe(1);
  });

  test('a pin the switch moved off Standard is kept as Abliterated', async () => {
    await RouterTaskConfig.create({ taskType: 'daily_operator', model: 'open:27b', host: 'primary' });
    expect(await choices.getChoices({ env: { AGENTX_DAILY_OPERATOR_MODEL: 'everyday:27b' }, pinnedModel: 'open:27b' }))
      .toMatchObject({ standard: 'everyday:27b', abliterated: 'open:27b' });
  });

  test('a pin without the switch route is not guessed as Abliterated', async () => {
    expect(await choices.getChoices({ env: { AGENTX_DAILY_OPERATOR_MODEL: 'everyday:27b' }, pinnedModel: 'manual:27b' }))
      .toMatchObject({ standard: 'everyday:27b', abliterated: null });
  });

  test('a fresh install names no model', async () => {
    expect(await choices.getChoices({ env: {}, pinnedModel: 'anything:7b' }))
      .toMatchObject({ standard: null, abliterated: null, revision: 0, source: 'migrated' });
    await expect(choices.requireAbliteratedModel()).rejects.toMatchObject({ code: 'PRINCIPAL_ABLITERATED_UNSET', statusCode: 503 });
  });

  test('a save is a compare-and-set on the revision the operator saw', async () => {
    await choices.getChoices({ env: {} });
    const saved = await choices.saveChoice({ option: 'abliterated', model: ' open:27b ', expectedRevision: 0, principal: 'owner' });
    expect(saved).toMatchObject({ abliterated: 'open:27b', revision: 1, source: 'operator', updatedBy: 'owner' });
    await expect(choices.saveChoice({ option: 'standard', model: 'everyday:27b', expectedRevision: 0 }))
      .rejects.toMatchObject({ code: 'PRINCIPAL_CHOICES_CHANGED' });
    await expect(choices.saveChoice({ option: 'standard', model: 'open:27b', expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'PRINCIPAL_CHOICES_DUPLICATE' });
    expect(await choices.requireAbliteratedModel()).toBe('open:27b');
  });
});
