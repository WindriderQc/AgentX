/**
 * The MQTT monitor tells its listener about each change of the broker link
 * once, and a shutdown is not a lost connection.
 */
const { EventEmitter } = require('events');

jest.mock('../../utils/logger', () => ({ log: jest.fn() }));

const { createMqttMonitor } = require('../../services/mqttMonitor');

class FakeClient extends EventEmitter {
  constructor() { super(); this.connected = false; }
  subscribe(topic, options, callback) { callback(null, [{ topic, qos: 0 }]); }
  end(_force, callback) { this.connected = false; this.emit('close'); callback(); }
}

const ENV = { MQTT_BROKER_URL: 'mqtt://user:synthetic-secret@broker.example:1883' };

function monitorWith(onStateChange) {
  const client = new FakeClient();
  const monitor = createMqttMonitor();
  monitor.init({ env: ENV, connect: () => client, onStateChange });
  return { monitor, client };
}

describe('MQTT monitor state changes', () => {
  test('reports connected, then disconnected once however many reconnections fail, then connected', () => {
    const states = [];
    const { client } = monitorWith((state, detail) => states.push([state, detail]));
    client.connected = true; client.emit('connect');
    client.connected = false;
    client.emit('error', new Error('connect ECONNREFUSED mqtt://user:synthetic-secret@broker.example'));
    client.emit('close'); client.emit('close'); client.emit('close');
    client.connected = true; client.emit('connect');
    expect(states.map(([state]) => state)).toEqual(['connected', 'disconnected', 'connected']);
    expect(states[0][1]).toMatchObject({ broker: 'broker.example:1883', error: null, everConnected: false });
    expect(states[1][1]).toMatchObject({ broker: 'broker.example:1883', everConnected: true });
    expect(states[1][1].error).toMatch(/ECONNREFUSED/);
    expect(JSON.stringify(states)).not.toContain('synthetic-secret');
  });

  test('a broker never reached is reported disconnected once', () => {
    const states = [];
    const { client } = monitorWith((state, detail) => states.push([state, detail.everConnected]));
    client.emit('close'); client.emit('close');
    expect(states).toEqual([['disconnected', false]]);
  });

  test('closing the monitor reports nothing, and a throwing listener breaks nothing', async () => {
    const states = [];
    const { monitor, client } = monitorWith((state) => { states.push(state); throw new Error('listener bug'); });
    client.connected = true; client.emit('connect');
    await monitor.close();
    expect(states).toEqual(['connected']);
    expect(monitor.status().connected).toBe(false);
  });
});
