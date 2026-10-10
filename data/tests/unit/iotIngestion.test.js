/**
 * The IoT consumer and its registry with a fake database and a fake clock:
 * what is stored, what is refused and counted, device states and the
 * transitions handed to the activity log.
 */
jest.mock('../../utils/logger', () => ({ log: jest.fn() }));

const { createIot } = require('../../services/iot');
const { createRegistry, MAX_DEVICES, MAX_MEASURES_PER_DEVICE, LIVE_RING_SIZE, STALE_AFTER_MS } = require('../../services/iot/registry');

const T0 = Date.UTC(2026, 0, 5, 10, 0, 0);

function fakeDb(deviceDocs = []) {
  const writes = { iot_minute_buckets: [], iot_devices: [] };
  let failBuckets = false;
  return {
    writes,
    failBuckets(value) { failBuckets = value; },
    collection(name) {
      return {
        find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => (name === 'iot_devices' ? deviceDocs : []) }) }) }),
        findOne: async () => null,
        bulkWrite: async (operations) => {
          if (name === 'iot_minute_buckets' && failBuckets) throw new Error('synthetic write failure');
          writes[name].push(...operations);
          return { upsertedCount: operations.length };
        },
        updateOne: async (filter, update) => { writes[name].push({ updateOne: { filter, update } }); return { upsertedCount: 1 }; }
      };
    }
  };
}

function fakeActivity() {
  const calls = [];
  const note = (kind) => async (_db, device, detail) => { calls.push([kind, device.id, detail]); return null; };
  return { calls, firstSeen: note('first_seen'), availability: async (_db, device, state, detail) => { calls.push(['availability', device.id, state, detail]); }, stale: note('stale'), recovered: note('recovered'), command: note('command') };
}

async function setup({ devices = [], monitor } = {}) {
  const clock = { ms: T0 };
  const db = fakeDb(devices);
  const activity = fakeActivity();
  const iot = createIot({ now: () => new Date(clock.ms), activity, monitor });
  await iot.ready(db);
  const say = (topic, payload, packet) => iot.handleMessage(topic, Buffer.from(String(payload)), packet);
  return { clock, db, activity, iot, say };
}

describe('readings', () => {
  test('are aggregated per minute and written once the minute has closed', async () => {
    const { clock, db, iot, say } = await setup();
    for (const [seconds, value] of [[1, '27.2'], [6, '27.4'], [11, '27.3']]) {
      clock.ms = T0 + seconds * 1000;
      expect(say('sensors/SYN_01/temperature', value)).toBe('');
      say('sensors/SYN_01/wifi_rssi', '-73');
    }
    clock.ms = T0 + 30_000;
    await iot.tick();
    expect(db.writes.iot_minute_buckets).toHaveLength(0);
    clock.ms = T0 + 66_000;
    await iot.tick();
    expect(db.writes.iot_minute_buckets.map((op) => op.updateOne.filter)).toEqual([
      { device: 'SYN_01', measure: 'temperature', ts: new Date(T0) },
      { device: 'SYN_01', measure: 'wifi_rssi', ts: new Date(T0) }
    ]);
    const status = await iot.status(db);
    expect(status.readings).toMatchObject({ accepted: 6, refused: 0 });
    expect(status.buckets).toMatchObject({ written: 2, open: 0, pendingRetry: 0 });
    expect(status.devices).toMatchObject({ tracked: 1, unknown: 1 });
  });

  test('shutdown writes the open minute', async () => {
    const { db, iot, say } = await setup();
    say('sensors/SYN_01/temperature', '20');
    await iot.stop();
    expect(db.writes.iot_minute_buckets).toHaveLength(1);
    expect(db.writes.iot_devices.length).toBeGreaterThan(0);
  });

  test('a failed write is retried at the next tick, not lost', async () => {
    const { clock, db, iot, say } = await setup();
    say('sensors/SYN_01/temperature', '20');
    db.failBuckets(true);
    clock.ms = T0 + 70_000;
    await iot.tick();
    expect((await iot.status(db)).buckets).toMatchObject({ written: 0, pendingRetry: 1, lastError: 'synthetic write failure' });
    db.failBuckets(false);
    clock.ms += 5000;
    await iot.tick();
    expect((await iot.status(db)).buckets).toMatchObject({ written: 1, pendingRetry: 0, lastError: null });
  });

  test.each([
    ['sensors/SYN_01/temperature', 'online', undefined, 'not_numeric'],
    ['sensors/SYN_01/temperature', '{"value":21}', undefined, 'not_numeric'],
    ['sensors/SYN_01/temperature', 'NaN', undefined, 'not_numeric'],
    ['sensors/SYN_01/temperature', '21.5', { retain: true }, 'retained_reading'],
    ['sensors/SYN_01/temperature/extra', '21.5', undefined, 'topic_shape'],
    [`sensors/SYN_01/${'m'.repeat(60)}`, '21.5', undefined, 'measure_name'],
    [`sensors/${'d'.repeat(300)}/temperature`, '21.5', undefined, 'topic_too_long'],
    ['sensors/SYN_01/availability', 'sleeping', undefined, 'availability_value'],
    ['esp32/register', 'not a device name', undefined, 'device_name'],
    ['homeassistant/device/SYN_01/config', '{broken', undefined, 'discovery_payload']
  ])('%s %j is refused and counted', async (topic, payload, packet, reason) => {
    const { db, iot, say } = await setup();
    expect(say(topic, payload, packet)).toBe(reason);
    const status = await iot.status(db);
    expect(status.readings).toMatchObject({ accepted: 0, refused: 1, refusedByReason: { [reason]: 1 } });
    await iot.stop();
    expect(db.writes.iot_minute_buckets).toHaveLength(0);
  });

  test('topics that are none of its business are not even counted', async () => {
    const { db, iot, say } = await setup();
    expect(say('liveData/iss', '{"latitude":1}')).toBe('');
    expect(say('esp32/SYN_01/io/on', '4')).toBe('');
    expect((await iot.status(db)).messages.received).toBe(0);
  });

  test('devices and measures are bounded', async () => {
    const { db, iot, say } = await setup();
    for (let i = 0; i < MAX_DEVICES; i++) say(`sensors/SYN_${i}/temperature`, '1');
    expect(say('sensors/SYN_extra/temperature', '1')).toBe('device_limit');
    expect(say('esp32/alive/SYN_other', '{}')).toBe('device_limit');
    for (let i = 0; i < MAX_MEASURES_PER_DEVICE - 1; i++) say(`sensors/SYN_0/m${i}`, '1');
    expect(say('sensors/SYN_0/one_too_many', '1')).toBe('measure_limit');
    const status = await iot.status(db);
    expect(status.devices.tracked).toBe(MAX_DEVICES);
    expect(status.readings.refusedByReason).toEqual({ device_limit: 2, measure_limit: 1 });
  });

  test('the bundled esp32/data readings and heartbeats store nothing: they refresh last seen', async () => {
    const { clock, db, iot, say } = await setup();
    say('esp32/alive/SYN_01', '{"message_type":"heartbeat"}');
    clock.ms = T0 + 4000;
    say('esp32/data/SYN_01', '{"payload":{"cpu_temp_c":64.4,"bmx_temp_c":27.1}}');
    const device = await iot.getDevice(db, 'SYN_01');
    expect(device.lastSeenAt).toBe(new Date(T0 + 4000).toISOString());
    expect(device.measures).toEqual([]);
    await iot.stop();
    expect(db.writes.iot_minute_buckets).toHaveLength(0);
    expect((await iot.status(db)).messages).toEqual({ received: 2, heartbeats: 1 });
  });
});

describe('device registry', () => {
  test('latest values, default units, discovery enrichment and the live ring', async () => {
    const { clock, db, iot, say } = await setup();
    say('sensors/SYN_01/temperature', '27.2');
    say('sensors/SYN_01/soil_moisture', '41');
    say('esp32/register', 'SYN_01');
    say('homeassistant/device/SYN_01/config', JSON.stringify({
      device: { name: 'SYN_01', manufacturer: 'Synthetic', model: 'Node' },
      components: {
        temperature: { state_topic: 'sensors/SYN_01/temperature', name: 'Air temperature', unit_of_measurement: '°F', device_class: 'temperature' },
        humidity: { state_topic: 'sensors/SYN_01/humidity', name: 'Humidity', unit_of_measurement: '%' }
      }
    }), { retain: true });
    clock.ms = T0 + 5000;
    say('sensors/SYN_01/temperature', '27.4');
    const device = await iot.getDevice(db, 'SYN_01');
    expect(device).toMatchObject({
      id: 'SYN_01', status: 'unknown', availability: { state: 'unknown', since: null },
      firstSeenAt: new Date(T0).toISOString(), lastSeenAt: new Date(T0 + 5000).toISOString(), lastSeenAgeMs: 0,
      registeredAt: new Date(T0).toISOString(), discoveryAt: new Date(T0).toISOString(),
      info: { name: 'SYN_01', manufacturer: 'Synthetic', model: 'Node', swVersion: null },
      displayName: null, location: null, notes: null
    });
    expect(device.measures).toEqual([
      expect.objectContaining({ key: 'temperature', name: 'Air temperature', unit: '°F', deviceClass: 'temperature', source: 'discovery', value: 27.4, ageMs: 0 }),
      expect.objectContaining({ key: 'soil_moisture', name: 'Soil moisture', unit: null, source: 'default', value: 41, ageMs: 5000 }),
      expect.objectContaining({ key: 'humidity', name: 'Humidity', unit: '%', source: 'discovery', value: null, at: null, ageMs: null })
    ]);
    const live = await iot.readLive(db, 'SYN_01', { measure: 'temperature' });
    expect(live).toMatchObject({ device: 'SYN_01', ringSize: LIVE_RING_SIZE });
    expect(live.measures.temperature.points).toEqual([
      { ts: new Date(T0).toISOString(), value: 27.2 }, { ts: new Date(T0 + 5000).toISOString(), value: 27.4 }
    ]);
    await expect(iot.readLive(db, 'SYN_01', { measure: 'nope' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(iot.getDevice(db, 'SYN_99')).rejects.toMatchObject({ statusCode: 404 });
  });

  test('the live ring keeps the last readings only', async () => {
    const { clock, db, iot, say } = await setup();
    for (let i = 0; i < LIVE_RING_SIZE + 15; i++) { clock.ms = T0 + i * 1000; say('sensors/SYN_01/temperature', String(i)); }
    const { points } = (await iot.readLive(db, 'SYN_01', {})).measures.temperature;
    expect(points).toHaveLength(LIVE_RING_SIZE);
    expect(points[0].value).toBe(15);
    expect(points.at(-1).value).toBe(LIVE_RING_SIZE + 14);
  });

  test('is loaded from the database, owner fields included', async () => {
    const { db, iot } = await setup({
      devices: [{
        _id: 'SYN_07', firstSeenAt: new Date(T0 - 86_400_000), lastSeenAt: new Date(T0 - 1000),
        availability: { state: 'online', since: new Date(T0 - 3_600_000) }, displayName: 'Greenhouse', location: 'Garden', notes: 'Synthetic',
        measures: [{ key: 'temperature', name: 'Temperature', unit: '°C', source: 'default', value: 12.5, at: new Date(T0 - 1000) }]
      }]
    });
    const [device] = await iot.listDevices(db);
    expect(device).toMatchObject({ id: 'SYN_07', status: 'online', displayName: 'Greenhouse', location: 'Garden', lastSeenAgeMs: 1000 });
    expect(device.measures[0]).toMatchObject({ key: 'temperature', value: 12.5, ageMs: 1000 });
  });

  test.each([
    [null], [[]], [{}], [{ displayName: 5 }], [{ id: 'x' }], [{ displayName: 'ok', status: 'online' }],
    [{ displayName: 'x'.repeat(81) }], [{ location: 'x'.repeat(81) }], [{ notes: 'x'.repeat(1001) }], [{ measures: [] }]
  ])('patch refuses %j', (body) => {
    expect(() => createRegistry().validatePatch(body)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  test('patch accepts the three owner fields, cleaned, and null to clear', () => {
    const registry = createRegistry();
    expect(registry.validatePatch({ displayName: '  Greenhouse\u0007 ', location: 'Garden', notes: 'line 1\nline 2' }))
      .toEqual({ displayName: 'Greenhouse', location: 'Garden', notes: 'line 1\nline 2' });
    expect(registry.validatePatch({ displayName: null, notes: '   ' })).toEqual({ displayName: null, notes: null });
  });
});

describe('availability and staleness', () => {
  const connected = () => ({ status: () => ({ configured: true, connected: true, connectedAt: new Date(T0).toISOString(), broker: 'broker.example:1883' }) });

  test('transitions are handed to the activity log once each, in order', async () => {
    const { clock, activity, db, iot, say } = await setup();
    say('sensors/SYN_01/availability', 'online');
    say('sensors/SYN_01/availability', 'online');
    clock.ms = T0 + 60_000;
    say('sensors/SYN_01/availability', 'offline');
    expect((await iot.getDevice(db, 'SYN_01'))).toMatchObject({
      status: 'offline', availability: { state: 'offline', since: new Date(T0 + 60_000).toISOString() },
      lastSeenAt: new Date(T0).toISOString()
    });
    clock.ms = T0 + 120_000;
    say('sensors/SYN_01/availability', 'online');
    await iot.stop();
    expect(activity.calls).toEqual([
      ['first_seen', 'SYN_01', undefined],
      ['availability', 'SYN_01', 'online', { retained: false }],
      ['availability', 'SYN_01', 'offline', { retained: false }],
      ['availability', 'SYN_01', 'online', { retained: false }]
    ]);
  });

  test('a retained state is the state as found: it sets availability but is not the device speaking', async () => {
    const { activity, db, iot, say } = await setup();
    say('sensors/SYN_01/availability', 'online', { retain: true });
    const device = await iot.getDevice(db, 'SYN_01');
    expect(device).toMatchObject({ status: 'online', lastSeenAt: null, lastSeenAgeMs: null });
    await iot.stop();
    expect(activity.calls[1]).toEqual(['availability', 'SYN_01', 'online', { retained: true }]);
  });

  test('silent for five minutes without an offline message: stale, then recovered at the next message', async () => {
    const monitor = connected();
    const { clock, activity, db, iot, say } = await setup({ monitor });
    await iot.start(db, { mqttMonitor: { ...monitor, addListener: () => () => {} }, env: { NODE_ENV: 'test' } });
    // start() does nothing in a test process: judge staleness through the registry.
    const registry = await iot.ready(db);
    say('sensors/SYN_01/availability', 'online');
    say('sensors/SYN_02/availability', 'offline');
    say('homeassistant/device/SYN_03/config', '{"device":{"name":"never spoke"}}', { retain: true });
    clock.ms = T0 + STALE_AFTER_MS;
    expect(registry.sweepStale(new Date(clock.ms))).toBe(0);
    clock.ms += 1000;
    expect(registry.sweepStale(new Date(clock.ms))).toBe(2);
    expect(registry.sweepStale(new Date(clock.ms))).toBe(0);
    expect((await iot.listDevices(db)).map((device) => [device.id, device.status])).toEqual([
      ['SYN_01', 'stale'], ['SYN_02', 'offline'], ['SYN_03', 'stale']
    ]);
    clock.ms += 1000;
    say('esp32/alive/SYN_01', '{}');
    expect((await iot.getDevice(db, 'SYN_01'))).toMatchObject({ status: 'online', staleSince: null });
    await iot.stop();
    // The device that never spoke goes stale without an event.
    expect(activity.calls.filter(([kind]) => kind === 'stale' || kind === 'recovered')).toEqual([
      ['stale', 'SYN_01', { silentForMs: STALE_AFTER_MS + 1000 }],
      ['recovered', 'SYN_01', undefined]
    ]);
  });

  test('silence is counted from when Data started listening, not from before', () => {
    const registry = createRegistry({ bootAt: new Date(T0) });
    registry.seen('SYN_01', new Date(T0 - 3_600_000));
    expect(registry.sweepStale(new Date(T0 + 60_000))).toBe(0);
    expect(registry.sweepStale(new Date(T0 + STALE_AFTER_MS + 60_000), new Date(T0 + STALE_AFTER_MS))).toBe(0);
    expect(registry.sweepStale(new Date(T0 + STALE_AFTER_MS + 1))).toBe(1);
  });

  test('an offline message ends a staleness; offline devices never go stale', () => {
    const events = [];
    const registry = createRegistry({ bootAt: new Date(T0), emit: (event) => events.push(event.kind) });
    registry.seen('SYN_01', new Date(T0));
    registry.sweepStale(new Date(T0 + STALE_AFTER_MS + 1));
    registry.availability('SYN_01', 'offline', new Date(T0 + STALE_AFTER_MS + 2));
    expect(registry.statusOf(registry.get('SYN_01'))).toBe('offline');
    expect(registry.get('SYN_01').stale).toBe(false);
    expect(registry.sweepStale(new Date(T0 + 10 * STALE_AFTER_MS))).toBe(0);
    expect(events).toEqual(['first_seen', 'stale', 'availability']);
  });
});

describe('commands', () => {
  const body = { command: 'io_on', gpio: 5 };

  test('publish the exact topic through the monitor and log one event', async () => {
    const published = [];
    const monitor = { status: () => ({}), publish: async (message) => { published.push(message); return { ...message, publishedAt: '2026-01-05T10:00:00.000Z' }; } };
    const { activity, db, iot, say } = await setup({ monitor });
    say('esp32/alive/SYN_01', '{}');
    const result = await iot.sendCommand(db, 'SYN_01', body);
    expect(published).toEqual([{ topic: 'esp32/SYN_01/io/on', payload: '5', retain: false }]);
    expect(result).toEqual({
      device: 'SYN_01', deviceStatus: 'unknown', command: 'io_on', gpio: 5,
      topic: 'esp32/SYN_01/io/on', qos: 0, retain: false, publishedAt: '2026-01-05T10:00:00.000Z'
    });
    expect(activity.calls.at(-1)).toEqual(['command', 'SYN_01', { command: 'io_on', gpio: 5, topic: 'esp32/SYN_01/io/on' }]);
  });

  test('fail fast when the broker is not connected, and log the failure', async () => {
    const refusal = Object.assign(new Error('MQTT broker is not connected. The message was not sent and is not queued.'), { statusCode: 503 });
    const monitor = { status: () => ({}), publish: () => { throw refusal; } };
    const { activity, db, iot, say } = await setup({ monitor });
    say('esp32/alive/SYN_01', '{}');
    await expect(iot.sendCommand(db, 'SYN_01', { command: 'reboot' })).rejects.toBe(refusal);
    expect(activity.calls.at(-1)).toEqual(['command', 'SYN_01', { command: 'reboot', gpio: null, topic: 'esp32/SYN_01/reboot', error: refusal.message }]);
  });

  test('an unknown device or an invalid command publishes nothing', async () => {
    const publish = jest.fn();
    const { activity, db, iot, say } = await setup({ monitor: { status: () => ({}), publish } });
    say('esp32/alive/SYN_01', '{}');
    await expect(iot.sendCommand(db, 'SYN_99', body)).rejects.toMatchObject({ statusCode: 404 });
    await expect(iot.sendCommand(db, '../SYN_01', body)).rejects.toMatchObject({ statusCode: 404 });
    await expect(iot.sendCommand(db, 'SYN_01', { command: 'io_on', gpio: 999 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(iot.sendCommand(db, 'SYN_01', { command: 'configIOs' })).rejects.toMatchObject({ statusCode: 400 });
    expect(publish).not.toHaveBeenCalled();
    expect(activity.calls.filter(([kind]) => kind === 'command')).toEqual([]);
  });
});
