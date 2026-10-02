const mongoose = require('mongoose');
const alertService = require('../../src/services/alertService');
const Alert = require('../../models/Alert');
const NetworkDeviceWatch = require('../../models/NetworkDeviceWatch');
const { createNetworkDeviceWatch, watchIntervalMs, normalizeMac } = require('../../src/services/networkDeviceWatch');

const rule = require('../../config/default-alert-rules.json').find(item => item.id === 'network-new-device');

function device(mac, extra = {}) {
  return { mac, ip: '192.0.2.10', hostname: '', vendor: 'Example Vendor', alias: '', firstSeen: '2026-01-01T00:00:00Z', ...extra };
}

describe('network device watch', () => {
  let inventory;
  let watch;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/agentx_test');
    }
    await Promise.all([Alert.syncIndexes(), NetworkDeviceWatch.syncIndexes()]);
    process.env.ALERT_TEST_MODE = 'true';
  });

  afterAll(async () => {
    await Promise.all([Alert.deleteMany({}), NetworkDeviceWatch.deleteMany({})]);
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await Promise.all([Alert.deleteMany({}), NetworkDeviceWatch.deleteMany({})]);
    alertService.loadRules([rule]);
    inventory = [device('AA:AA:AA:00:00:01'), device('AA:AA:AA:00:00:02', { alias: 'Printer' })];
    watch = createNetworkDeviceWatch({ loadDevices: async () => inventory });
  });

  test('ships a Telegram-delivered default rule', () => {
    expect(rule.channels).toEqual(['local_log', 'telegram']);
  });

  test('the first run records the inventory as the baseline without alerting', async () => {
    await expect(watch.check()).resolves.toEqual({ baseline: true, recorded: 2, alerted: 0 });
    await expect(Alert.countDocuments({})).resolves.toBe(0);
    await expect(NetworkDeviceWatch.countDocuments({ baseline: true })).resolves.toBe(2);
  });

  test('a new unknown device raises exactly one alert across repeated scans', async () => {
    await watch.check();
    inventory.push(device('aa-aa-aa-00-00-03', { ip: '192.0.2.30' }));

    await expect(watch.check()).resolves.toEqual({ baseline: false, recorded: 1, alerted: 1 });
    await expect(watch.check()).resolves.toEqual({ baseline: false, recorded: 0, alerted: 0 });

    const alerts = await Alert.find({ ruleId: 'network-new-device' }).lean();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toContain('AA:AA:AA:00:00:03 at 192.0.2.30 (no hostname)');
    expect(alerts[0].title).toContain('Example Vendor');
    expect(alerts[0].channels).toContain('telegram');

    // Even after the alert is resolved, the same device is not reported again.
    await Alert.updateMany({}, { $set: { status: 'resolved' } });
    await watch.check();
    await expect(Alert.countDocuments({ ruleId: 'network-new-device' })).resolves.toBe(1);
  });

  test('aliased, known and MAC-less devices never alert', async () => {
    await watch.check();
    inventory.push(
      device('AA:AA:AA:00:00:04', { alias: 'Tablet' }),
      device('AA:AA:AA:00:00:05', { knownAt: '2026-01-02T00:00:00Z' }),
      device(''),
    );

    await expect(watch.check()).resolves.toEqual({ baseline: false, recorded: 2, alerted: 0 });
    await expect(Alert.countDocuments({})).resolves.toBe(0);
  });

  test('a failed alert is retried on the next run', async () => {
    await watch.check();
    inventory.push(device('AA:AA:AA:00:00:06'));
    let fail = true;
    const flaky = createNetworkDeviceWatch({
      loadDevices: async () => inventory,
      evaluateEvent: async (event) => {
        if (fail) { fail = false; throw new Error('engine down'); }
        return alertService.evaluateEvent(event);
      },
    });

    await expect(flaky.check()).rejects.toThrow('engine down');
    await expect(flaky.check()).resolves.toEqual({ baseline: false, recorded: 0, alerted: 1 });
    await expect(Alert.countDocuments({ ruleId: 'network-new-device' })).resolves.toBe(1);
  });

  test('is opt-in with a one-minute floor and normalizes MACs', () => {
    expect(watchIntervalMs({})).toBe(0);
    expect(watchIntervalMs({ NETWORK_DEVICE_WATCH_MS: '1000' })).toBe(60000);
    expect(watchIntervalMs({ NETWORK_DEVICE_WATCH_MS: '300000' })).toBe(300000);
    expect(normalizeMac('aa-bb-cc-dd-ee-ff')).toBe('AA:BB:CC:DD:EE:FF');
    expect(normalizeMac('not-a-mac')).toBe('');
  });
});
