const net = require('node:net');
const packets = require('mqtt-packet');
const mqtt = require('mqtt');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { MongoClient } = require('mongodb');
jest.mock('../../utils/logger', () => ({ log: jest.fn() }));
const { createIot } = require('../../services/iot');
const { createMqttMonitor } = require('../../services/mqttMonitor');
const URI = process.env.MONGODB_URI_TEST;
const BASE = URI ? new URL(URI).pathname.slice(1) : '';
if (!BASE.startsWith('agentx_data_test_')) throw Error('Use the disposable Data test launcher');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (await predicate()) return; await delay(10); } throw Error('Synthetic MQTT condition timed out'); }

test('native mqtt.js uses one monitor connection, legacy packets and QoS 0/no retain; disconnection cannot queue an action', async () => {
  const sockets = new Set(), published = [];
  const broker = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    const parser = packets.parser(); socket.on('data', bytes => parser.parse(bytes));
    parser.on('packet', packet => {
      if (packet.cmd === 'connect') socket.write(packets.generate({ cmd: 'connack', returnCode: 0, sessionPresent: false }));
      if (packet.cmd === 'subscribe') socket.write(packets.generate({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(() => 0) }));
      if (packet.cmd === 'pingreq') socket.write(packets.generate({ cmd: 'pingresp' }));
      if (packet.cmd === 'publish') {
        published.push(packet);
        const bytes = packets.generate({ cmd: 'publish', topic: packet.topic, payload: packet.payload, qos: 0, retain: false, dup: false });
        for (const receiver of sockets) if (!receiver.destroyed) receiver.write(bytes);
      }
    });
  });
  broker.listen(0, '127.0.0.1'); await once(broker, 'listening');
  const url = `mqtt://127.0.0.1:${broker.address().port}`;
  let mongo, db, monitor, device, service;
  try {
    mongo = await new MongoClient(URI).connect(); db = mongo.db(`${BASE}_control_wire`);
    monitor = createMqttMonitor();
    service = createIot({ monitor });
    await service.start(db, { env: { NODE_ENV: 'fixture', MQTT_BROKER_URL: url } });
    const connection = monitor.init({ env: { MQTT_BROKER_URL: url }, connect: mqtt.connect });
    await once(connection, 'connect');
    device = mqtt.connect(url, { reconnectPeriod: 0 }); await once(device, 'connect');
    const id = 'SYN_WIRE', pin = { io: 15, mode: 'OUT', lbl: 'D15', isA: false, name: 'Lamp' };
    const state = { version: 1, bootId: 'abcdef01', serial: 1, config: [pin], timers: [],
      outputs: [{ io: 15, active: false, available: true, inverted: false }], clockValid: true,
      timezone: 'UTC-0500', localTime: '2026-01-01 07:00:00', lastError: null };
    device.publish(`sensors/${id}/availability`, 'online');
    device.publish(`esp32/${id}/state`, JSON.stringify(state));
    const controls = await service.control(db);
    await until(async () => (await controls.read(id).catch(() => null))?.observedFresh);
    await controls.saveProfile('Wire', { revision: 0, config: [pin] });
    await controls.assignProfile(id, { revision: 0, profileName: 'Wire', profileRevision: 1 });
    await controls.applyProfile(id, { requestId: randomUUID(), revision: 1, restoreOnBoot: false });
    await until(() => published.some(row => row.topic.endsWith('/configIOs')));
    device.publish(`esp32/${id}/state`, JSON.stringify({ ...state, serial: 2 }));
    await until(async () => !(await controls.read(id)).inFlight);
    await controls.saveTimer(id, '15', { revision: 1, io: 15, tStart: '23:00:00', tStop: '06:00:00', enabled: true });
    await controls.applyTimer(id, '15', { requestId: randomUUID(), revision: 2 });
    await until(() => published.filter(row => /\/io\/(sunrise|nightfall)$/.test(row.topic)).length === 2);
    const outbound = published.filter(row => /\/configIOs$|\/io\/(sunrise|nightfall)$/.test(row.topic));
    expect(outbound.map(row => [row.topic, row.payload.toString(), row.qos, row.retain])).toEqual([
      [`esp32/${id}/configIOs`, JSON.stringify([pin]), 0, false],
      [`esp32/${id}/io/sunrise`, '15:23:00:00', 0, false],
      [`esp32/${id}/io/nightfall`, '15:06:00:00', 0, false]
    ]);
    device.publish(`esp32/${id}/state`, JSON.stringify({ ...state, serial: 3, timers: [{ io: 15, tStart: '23:00:00', tStop: '06:00:00', enabled: true, nextStart: null }] }));
    await until(async () => !(await controls.read(id)).inFlight);
    await monitor.close();
    await expect(controls.applyTimer(id, '15', { requestId: randomUUID(), revision: 2 })).rejects.toMatchObject({ statusCode: 503 });
    expect(published.filter(row => /\/io\/(sunrise|nightfall)$/.test(row.topic))).toHaveLength(2);
  } finally {
    if (service) await service.stop(); if (monitor) await monitor.close(); if (device) device.end(true);
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => broker.close(resolve));
    if (db) await db.dropDatabase(); if (mongo) await mongo.close();
  }
}, 15000);
