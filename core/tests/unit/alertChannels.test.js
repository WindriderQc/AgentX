'use strict';

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const logger = require('../../config/logger');
const Alert = require('../../models/Alert');
const AlertRule = require('../../models/AlertRule');
const alertService = require('../../src/services/alertService');
const { ALERT_CHANNELS, sanitizeAlertChannels } = require('../../models/alertChannels');

describe('alert channels', () => {
  afterEach(async () => {
    await Promise.all([
      Alert.deleteMany({ ruleId: 'channel-guard-test' }),
      AlertRule.deleteMany({ ruleId: 'channel-guard-test' })
    ]);
  });

  it('keeps known channels in order and drops unknown ones with a warning', () => {
    expect(sanitizeAlertChannels(['dataapi_log', 'telegram', 'telegram', 'local_log'], 'r1'))
      .toEqual(['telegram', 'local_log']);
    expect(logger.warn).toHaveBeenCalledWith('[AlertService] Dropping unknown alert channels',
      { ruleId: 'r1', dropped: ['dataapi_log'] });
  });

  it('falls back to the local log when nothing known is left', () => {
    expect(sanitizeAlertChannels(['dataapi_log'])).toEqual(['local_log']);
    expect(sanitizeAlertChannels(undefined)).toEqual(['local_log']);
  });

  it('shares one list between rules and alerts', () => {
    expect(Alert.schema.path('channels').caster.enumValues).toEqual([...ALERT_CHANNELS]);
    expect(AlertRule.schema.path('channels').caster.enumValues).toEqual([...ALERT_CHANNELS]);
  });

  it('rejects a rule that names an unknown channel', async () => {
    await expect(AlertRule.create({
      ruleId: 'channel-guard-test',
      name: 'Channel guard test',
      severity: 'warning',
      conditions: { all: [{ fact: 'metric', operator: 'equal', value: 'channel_guard' }] },
      channels: ['dataapi_log', 'telegram']
    })).rejects.toThrow(/dataapi_log/);
  });

  it('still stores the alert when an in-memory rule carries an unknown channel', async () => {
    alertService.loadRules([{
      id: 'channel-guard-test',
      name: 'Channel guard test',
      enabled: true,
      severity: 'error',
      conditions: { all: [{ fact: 'metric', operator: 'equal', value: 'channel_guard' }] },
      channels: ['dataapi_log', 'local_log'],
      title: 'Channel guard',
      message: 'test'
    }]);
    const alerts = await alertService.evaluateEvent({ component: 'test', metric: 'channel_guard', value: 1 });

    expect(alerts).toHaveLength(1);
    const stored = await Alert.findOne({ ruleId: 'channel-guard-test' }).lean();
    expect(stored.channels).toEqual(['local_log']);
    expect(stored.delivery.local_log.sent).toBe(true);
  });
});
