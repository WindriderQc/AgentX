const mongoose = require('mongoose');
const alertService = require('../../src/services/alertService');
const Alert = require('../../models/Alert');
const NetworkDeviceWatch = require('../../models/NetworkDeviceWatch');
const { createNetworkDeviceWatch, watchIntervalMs, normalizeMac, guessSentence, NO_GUESS } = require('../../src/services/networkDeviceWatch');

const rule = require('../../config/default-alert-rules.json').find(item => item.id === 'network-new-device');

function device(mac, extra = {}) {
  return { mac, ip: '192.0.2.10', hostname: '', vendor: 'Example Vendor', alias: '', firstSeen: '2026-01-01T00:00:00Z', ...extra };
}

describe('network device watch', () => {
  let inventory;
  let watch;
  let guess;

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
    guess = '';
    watch = createNetworkDeviceWatch({ loadDevices: async () => inventory, guessFor: async () => guess });
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
    expect(alerts[0].message).toContain('AA:AA:AA:00:00:03 at 192.0.2.30 (no hostname). No guess of what it is. Name it');
    expect(alerts[0].title).toContain('Example Vendor');
    expect(alerts[0].channels).toContain('telegram');

    // Even after the alert is resolved, the same device is not reported again.
    await Alert.updateMany({}, { $set: { status: 'resolved' } });
    await watch.check();
    await expect(Alert.countDocuments({ ruleId: 'network-new-device' })).resolves.toBe(1);
  });

  test('the alert carries the model guess of what the device is', async () => {
    await watch.check();
    inventory.push(device('AA:AA:AA:00:00:07', { hostname: 'tv-box' }));
    guess = 'Sure: {"kind": "smart TV", "name": "living-room-tv"}';
    await watch.check();
    const alert = await Alert.findOne({ ruleId: 'network-new-device' }).lean();
    expect(alert.message).toContain('(tv-box). Probably smart TV; suggested name: living-room-tv. Name it or mark it known');
  });

  test('an unusable, unknown or failed guess leaves the plain alert', async () => {
    expect(guessSentence('{"kind": "unknown", "name": "x"}')).toBe(NO_GUESS);
    expect(guessSentence('not json')).toBe(NO_GUESS);
    expect(guessSentence('{"kind": "printer"}')).toBe('Probably printer.');
    await watch.check();
    inventory.push(device('AA:AA:AA:00:00:08'));
    const failing = createNetworkDeviceWatch({ loadDevices: async () => inventory,
      guessFor: async () => { throw new Error('host busy'); } });
    await expect(failing.check()).resolves.toMatchObject({ alerted: 1 });
    const alert = await Alert.findOne({ ruleId: 'network-new-device' }).lean();
    expect(alert.message).toContain('No guess of what it is.');
    expect(alert.message).not.toContain('[missing:');
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
      guessFor: async () => '',
      evaluateEvent: async (event) => {
        if (fail) { fail = false; throw new Error('engine down'); }
        return alertService.evaluateEvent(event);
      },
    });

    await expect(flaky.check()).rejects.toThrow('engine down');
    await expect(flaky.check()).resolves.toEqual({ baseline: false, recorded: 0, alerted: 1 });
    await expect(Alert.countDocuments({ ruleId: 'network-new-device' })).resolves.toBe(1);
  });

  test('the first check waits one minute after start, then follows the interval', () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      const timed = createNetworkDeviceWatch({ loadDevices: async () => { calls += 1; return []; } });
      expect(timed.start(300000)).toBe(true);
      expect(timed.start(300000)).toBe(false);
      jest.advanceTimersByTime(59999);
      expect(calls).toBe(0);
      jest.advanceTimersByTime(1);
      expect(calls).toBe(1);
      timed.stop();
      jest.advanceTimersByTime(600000);
      expect(calls).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('is opt-in with a one-minute floor and normalizes MACs', () => {
    expect(watchIntervalMs({})).toBe(0);
    expect(watchIntervalMs({ NETWORK_DEVICE_WATCH_MS: '1000' })).toBe(60000);
    expect(watchIntervalMs({ NETWORK_DEVICE_WATCH_MS: '300000' })).toBe(300000);
    expect(normalizeMac('aa-bb-cc-dd-ee-ff')).toBe('AA:BB:CC:DD:EE:FF');
    expect(normalizeMac('not-a-mac')).toBe('');
  });
});
