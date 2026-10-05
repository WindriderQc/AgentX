'use strict';

jest.mock('../../models/AlertRule', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  updateOne: jest.fn(),
  updateMany: jest.fn(),
}));

jest.mock('../../src/services/alertService', () => ({
  loadRules: jest.fn(),
}));

const AlertRule = require('../../models/AlertRule');
const alertService = require('../../src/services/alertService');
const {
  seedDefaultRules,
  RETIRED_BUILT_IN_RULE_IDS,
} = require('../../src/services/alertRuleSeeder');

describe('alertRuleSeeder retired built-ins', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AlertRule.updateMany.mockResolvedValue({ modifiedCount: 0 });
    AlertRule.findOne.mockResolvedValue({
      builtIn: true,
      title: 'existing title',
      message: 'existing message',
      renotifyMs: 1,
    });
    AlertRule.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });
  });

  test('does not seed rules for the removed host-capacity producer', () => {
    const defaults = require('../../config/default-alert-rules.json');
    const ids = defaults.map((rule) => rule.id);

    expect(RETIRED_BUILT_IN_RULE_IDS).toEqual([
      'capacity-vram-pressure',
      'capacity-gpu-imbalance',
      'capacity-underused',
      'capacity-host-critical',
    ]);
    for (const retiredId of RETIRED_BUILT_IN_RULE_IDS) {
      expect(ids).not.toContain(retiredId);
    }
  });

  test('disables persisted built-ins and reloads the active engine rules', async () => {
    AlertRule.updateMany.mockResolvedValue({ modifiedCount: RETIRED_BUILT_IN_RULE_IDS.length });

    await expect(seedDefaultRules()).resolves.toBe(0);

    expect(AlertRule.updateMany).toHaveBeenCalledWith(
      {
        ruleId: { $in: RETIRED_BUILT_IN_RULE_IDS },
        builtIn: true,
        enabled: true,
      },
      { $set: { enabled: false } }
    );
    expect(AlertRule.create).not.toHaveBeenCalled();
    expect(AlertRule.find).toHaveBeenCalledWith({ enabled: true });
    expect(alertService.loadRules).toHaveBeenCalledWith([]);
  });

  test('refreshes a built-in message the operator never edited, and leaves a customised one', async () => {
    const defaults = require('../../config/default-alert-rules.json');
    const rule = defaults.find(item => item.id === 'network-new-device');
    AlertRule.findOne.mockImplementation(async ({ ruleId }) => ({
      builtIn: true, title: 'existing title', renotifyMs: 1,
      message: ruleId === 'network-new-device' ? rule.previousMessages[0] : 'my own wording'
    }));
    await seedDefaultRules();
    expect(AlertRule.updateOne).toHaveBeenCalledTimes(1);
    expect(AlertRule.updateOne).toHaveBeenCalledWith({ ruleId: 'network-new-device' }, { $set: { message: rule.message } });
    expect(rule.message).toContain('{{guess}}');
  });
});
