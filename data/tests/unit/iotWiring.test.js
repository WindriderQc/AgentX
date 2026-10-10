/**
 * How the IoT store is attached to the rest of Data: the monitor's listener
 * hook, the conditions under which ingestion starts, and the `sensors` live
 * feed that no longer stores every message.
 */
const { EventEmitter } = require('events');

jest.mock('../../utils/logger', () => ({ log: jest.fn() }));

const { createMqttMonitor } = require('../../services/mqttMonitor');
const { createIot } = require('../../services/iot');
const liveStore = require('../../services/livedata/store');
const registry = require('../../services/livedata/registry');

class FakeClient extends EventEmitter {
  constructor() { super(); this.connected = false; }
  subscribe(topic, options, callback) { callback(null, [{ topic, qos: 0 }]); }
  end(_force, callback) { this.connected = false; callback(); }
}

const ENV = { MQTT_BROKER_URL: 'mqtt://broker.example:1883' };
const emptyDb = {
  collection: () => ({
    find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }), findOne: async () => null,
    bulkWrite: async () => ({}), updateOne: async () => ({})
  })
};

describe('MQTT monitor listeners', () => {
  test('receive the raw message and the packet, without changing what the monitor keeps', () => {
    const client = new FakeClient();
    const monitor = createMqttMonitor();
    monitor.init({ env: ENV, connect: () => client });
    const heard = [];
    const remove = monitor.addListener((topic, payload, packet) => heard.push([topic, payload.toString(), packet.retain]));
    monitor.addListener(() => { throw new Error('a listener that fails'); });
    client.emit('message', 'sensors/SYN_01/temperature', Buffer.from('21.5'), { retain: false, qos: 0 });
    client.emit('message', 'sensors/SYN_01/availability', Buffer.from('online'), { retain: true, qos: 0 });
    expect(heard).toEqual([['sensors/SYN_01/temperature', '21.5', false], ['sensors/SYN_01/availability', 'online', true]]);
    expect(monitor.messages().messages.map((message) => [message.topic, message.payload, message.retained])).toEqual(heard);
    expect(monitor.status().lastError).toBeNull();
    remove();
    client.emit('message', 'sensors/SYN_01/temperature', Buffer.from('22'), {});
    expect(heard).toHaveLength(2);
    expect(monitor.status().received).toBe(3);
  });
});

describe('ingestion start conditions', () => {
  function monitorSpy() {
    const added = [];
    return { added, addListener: (listener) => { added.push(listener); return () => added.splice(added.indexOf(listener), 1); }, status: () => ({}) };
  }

  test('never in a test process', async () => {
    const iot = createIot();
    const monitor = monitorSpy();
    expect(await iot.start(emptyDb, { mqttMonitor: monitor, env: { ...ENV, NODE_ENV: 'test' } })).toBe(false);
    expect(monitor.added).toHaveLength(0);
    expect(iot.isConsuming()).toBe(false);
  });

  test('only when a broker is configured; background jobs are not required', async () => {
    const without = createIot();
    const idle = monitorSpy();
    expect(await without.start(emptyDb, { mqttMonitor: idle, env: { NODE_ENV: 'production' } })).toBe(true);
    expect(idle.added).toHaveLength(0);
    expect(without.isConsuming()).toBe(false);
    await without.stop();

    const configured = createIot();
    const monitor = monitorSpy();
    expect(await configured.start(emptyDb, { mqttMonitor: monitor, env: { ...ENV, NODE_ENV: 'production', DATA_BACKGROUND_JOBS_ENABLED: 'false' } })).toBe(true);
    expect(monitor.added).toHaveLength(1);
    expect(configured.isConsuming()).toBe(true);
    await configured.stop();
    expect(monitor.added).toHaveLength(0);
  });
});

describe('sensors live feed', () => {
  const feed = () => registry.resolveRegistry([], []).find((entry) => entry.id === 'sensors');

  function fakePoints() {
    const upserts = [];
    return {
      upserts,
      collection: (name) => ({
        name,
        updateOne: async (filter, update, options) => { upserts.push({ name, filter, update, options }); },
        deleteMany: async () => ({ deletedCount: 0 }),
        insertMany: async () => { throw new Error('the sensors feed must never insert a point per message'); }
      })
    };
  }

  beforeEach(() => liveStore._resetLatestWrites());

  test('keeps one document per topic, replaced at most once a minute', async () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 0, 5, 10, 0, 0) });
    try {
      const db = fakePoints();
      const point = (topic, value) => [{ ts: new Date(), payload: { topic, value } }];
      expect(await liveStore.write(db, feed(), point('sensors/SYN_01/temperature', 21))).toBe(1);
      expect(await liveStore.write(db, feed(), point('sensors/SYN_01/pressure', 1013))).toBe(1);
      for (let i = 0; i < 11; i++) {
        jest.advanceTimersByTime(5000);
        expect(await liveStore.write(db, feed(), point('sensors/SYN_01/temperature', 21 + i))).toBe(0);
      }
      jest.advanceTimersByTime(5000);
      expect(await liveStore.write(db, feed(), point('sensors/SYN_01/temperature', 30))).toBe(1);
      expect(db.upserts).toHaveLength(3);
      expect(db.upserts[2]).toMatchObject({
        name: 'livedata_points',
        filter: { feedId: 'sensors', latest: true, key: 'sensors/SYN_01/temperature' },
        update: { $set: { feedId: 'sensors', latest: true, payload: { topic: 'sensors/SYN_01/temperature', value: 30 } } },
        options: { upsert: true }
      });
    } finally { jest.useRealTimers(); }
  });

  test('keeps coordinates for the map and bounds the number of topics', async () => {
    const db = fakePoints();
    await liveStore.write(db, feed(), [{ ts: new Date(), payload: { topic: 'sensors/SYN_02', temp: 4, lat: 46.8, lon: -71.2 }, lat: 46.8, lon: -71.2 }]);
    expect(db.upserts[0].update.$set.geo).toEqual({ lat: 46.8, lon: -71.2 });
    for (let i = 0; i < liveStore.LATEST_MAX_KEYS + 20; i++) {
      await liveStore.write(db, feed(), [{ ts: new Date(), payload: { topic: `sensors/SYN_${i}/t`, value: i } }]);
    }
    expect(db.upserts).toHaveLength(liveStore.LATEST_MAX_KEYS);
    expect(await liveStore.write(db, feed(), [{ ts: new Date(), payload: { value: 1 } }])).toBe(0);
  });
});
