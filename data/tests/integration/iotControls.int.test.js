const { MongoClient } = require('mongodb');
const { randomUUID } = require('node:crypto');
const express = require('express');
const request = require('supertest');
jest.mock('../../utils/logger', () => ({ log: jest.fn() }));
const { createControls, PROFILES, SETTINGS, OPERATIONS } = require('../../services/iot/controls');
const rules = require('../../../shared/iotControlRules');
const iot = require('../../services/iot');
const URI = process.env.MONGODB_URI_TEST;
const BASE = URI ? new URL(URI).pathname.slice(1) : '';
if (!BASE.startsWith('agentx_data_test_')) throw Error('Use the disposable Data test launcher');
const ID = 'SYN_CTRL_1';
const pin = { io: 15, mode: 'OUT', lbl: 'D15', isA: false, name: 'Lamp' };
const clock = { ms: Date.UTC(2026, 0, 1, 12) };
const report = (overrides = {}) => ({ version: 1, bootId: 'abcdef01', serial: 1, config: [pin], timers: [],
  outputs: [{ io: 15, active: false, available: true, inverted: false }], clockValid: true,
  timezone: 'UTC-0500', localTime: '2026-01-01 07:00:00', lastError: null, ...overrides });

describe('IoT profiles and daily timers, disposable Mongo and synthetic MQTT', () => {
  let client, db, controls, calls, link, device, failPublish;
  beforeAll(async () => { client = await new MongoClient(URI).connect(); db = client.db(`${BASE}_controls`); });
  afterAll(async () => { await db.dropDatabase(); await client.close(); });
  beforeEach(async () => {
    for (const name of [PROFILES, SETTINGS, OPERATIONS, 'appevents']) await db.collection(name).deleteMany({});
    clock.ms = Date.UTC(2026, 0, 1, 12); calls = []; failPublish = null;
    link = { connected: true, configured: true }; device = { id: ID, status: 'online' };
    controls = createControls({ db, now: () => new Date(clock.ms), seen: () => true,
      deviceOr404: async id => { if (id !== ID) rules.fail('Unknown device', 404); return device; },
      monitor: { status: () => link, publish: async message => {
        if (failPublish) throw failPublish;
        calls.push(message); return { publishedAt: new Date(clock.ms).toISOString(), ...message };
      } } });
  });
  async function state(overrides) {
    expect(controls.handleMessage(`esp32/${ID}/state`, Buffer.from(JSON.stringify(report(overrides))))).toBe('');
    await controls.drain();
  }
  async function profile() {
    const saved = await controls.saveProfile('Grow', { revision: 0, config: [pin] });
    return controls.assignProfile(ID, { revision: 0, profileName: 'Grow', profileRevision: saved.revision });
  }
  async function schedule(enabled = true) {
    await state();
    return controls.saveTimer(ID, '15', { revision: 0, io: 15, tStart: '23:00:00', tStop: '06:00:00', enabled });
  }
  test('profiles preserve the original five fields, version saves and freeze per-device assignments; saving publishes nothing', async () => {
    const assigned = await profile();
    expect(assigned).toMatchObject({ revision: 1, profileName: 'Grow', profileRevision: 1, config: [pin], restoreOnBoot: false });
    expect(calls).toEqual([]);
    await controls.saveProfile('Grow', { revision: 1, config: [{ ...pin, name: 'Changed' }] });
    expect((await controls.read(ID)).config).toEqual([pin]);
    await expect(controls.saveProfile('Grow', { revision: 1, config: [pin] })).rejects.toMatchObject({ statusCode: 409 });
    await expect(controls.saveProfile('Grow', { revision: 0, config: [pin] })).rejects.toMatchObject({ statusCode: 409 });
    await expect(controls.assignProfile(ID, { revision: 1, profileName: 'Grow', profileRevision: 1 })).rejects.toMatchObject({ statusCode: 409 });
  });
  test('rejects bad profiles, duplicate GPIOs, ambiguous equal times and string booleans before storing or publishing', async () => {
    for (const config of [[{ ...pin, isA: '0' }], [pin, pin], [{ ...pin, retain: true }], [{ ...pin, io: 49 }], [{ ...pin, isA: true }]])
      await expect(controls.saveProfile('Bad', { revision: 0, config })).rejects.toMatchObject({ statusCode: 400 });
    for (const row of [{ tStart: '25:00:00' }, { tStop: '06:00:00' }, { enabled: 'true' }])
      await expect(controls.saveTimer(ID, '15', { revision: 0, io: 15, tStart: '06:00:00', tStop: '23:00:00', enabled: true, ...row })).rejects.toMatchObject({ statusCode: 400 });
    expect(calls).toEqual([]);
    expect(await db.collection(PROFILES).countDocuments()).toBe(0);
  });
  test('disconnected, offline, old firmware and stale state refuse immediately and leave no deferred action', async () => {
    await profile();
    const body = { requestId: randomUUID(), revision: 1, restoreOnBoot: false };
    await expect(controls.applyProfile(ID, body)).rejects.toMatchObject({ statusCode: 409 });
    await state(); link.connected = false;
    await expect(controls.applyProfile(ID, body)).rejects.toMatchObject({ statusCode: 503 });
    link.connected = true; device.status = 'offline';
    await expect(controls.applyProfile(ID, body)).rejects.toMatchObject({ statusCode: 409 });
    device.status = 'online'; clock.ms += 61000;
    await expect(controls.applyProfile(ID, body)).rejects.toMatchObject({ statusCode: 409 });
    expect(await db.collection(OPERATIONS).countDocuments()).toBe(0);
    expect(calls).toEqual([]);
  });
  test('publication and device report are distinct; replay with the same identity never sends twice', async () => {
    await profile(); await state();
    const body = { requestId: randomUUID(), revision: 1, restoreOnBoot: true };
    const result = await controls.applyProfile(ID, body);
    expect(result.outcome).toBe('published');
    expect(calls).toEqual([{ topic: `esp32/${ID}/configIOs`, payload: JSON.stringify([pin]), retain: false }]);
    expect((await controls.read(ID)).inFlight).toBe(body.requestId);
    await expect(controls.saveTimer(ID, '15', { revision: 1, io: 15, tStart: '06:00:00', tStop: '23:00:00', enabled: true })).rejects.toMatchObject({ statusCode: 409 });
    await controls.applyProfile(ID, body);
    expect(calls).toHaveLength(1);
    await state({ serial: 2 });
    expect((await controls.read(ID)).inFlight).toBeUndefined();
    expect((await controls.applyProfile(ID, body)).outcome).toBe('acknowledged');
    await expect(controls.applyProfile(ID, { ...body, restoreOnBoot: false })).rejects.toMatchObject({ statusCode: 409 });
    expect(calls).toHaveLength(1);
  });
  test('a daily timer uses the exact SBQC pair; a newer matching report acknowledges it, cancellation uses one non-retained message', async () => {
    const doc = await schedule();
    const body = { requestId: randomUUID(), revision: doc.revision };
    await controls.applyTimer(ID, '15', body);
    expect(calls.map(row => [row.topic, row.payload, row.retain])).toEqual([
      [`esp32/${ID}/io/sunrise`, '15:23:00:00', false], [`esp32/${ID}/io/nightfall`, '15:06:00:00', false]
    ]);
    await state({ serial: 2, timers: [{ ...doc.timers[0], nextStart: '2026-01-02T04:00:00Z' }] });
    expect((await controls.read(ID)).inFlight).toBeUndefined();
    await controls.saveTimer(ID, '15', { revision: 1, io: 15, tStart: '22:00:00', tStop: '05:00:00', enabled: false });
    await controls.applyTimer(ID, '15', { requestId: randomUUID(), revision: 2 });
    expect(calls.at(-1)).toEqual({ topic: `esp32/${ID}/io/timer/disable`, payload: '15', retain: false });
    await state({ serial: 3, timers: [{ ...doc.timers[0], enabled: false, nextStart: null }] });
    expect((await controls.read(ID)).inFlight).toBeUndefined();
  });
  test('a lost broker reply stays fenced across restart; an old report cannot acknowledge it, a fresh matching one can', async () => {
    await schedule(); failPublish = Object.assign(new Error('write uncertain'), { statusCode: 504 });
    const body = { requestId: randomUUID(), revision: 1 };
    expect((await controls.applyTimer(ID, '15', body)).outcome).toBe('uncertain');
    failPublish = null;
    const restarted = createControls({ db, now: () => new Date(clock.ms), deviceOr404: async () => device, seen: () => true,
      monitor: { status: () => link, publish: async () => { throw Error('must not publish'); } } });
    expect((await restarted.applyTimer(ID, '15', body)).outcome).toBe('uncertain');
    await expect(restarted.applyTimer(ID, '15', { ...body, requestId: randomUUID() })).rejects.toMatchObject({ statusCode: 409 });
    const doc = await controls.read(ID);
    await state({ serial: 1, timers: [{ ...doc.timers[0], nextStart: null }] });
    expect((await controls.read(ID)).inFlight).toBe(body.requestId);
    await state({ serial: 2, timers: [{ ...doc.timers[0], nextStart: '2026-01-02T04:00:00Z' }] });
    expect((await controls.read(ID)).inFlight).toBeUndefined();
  });
  test('explicit reconciliation needs a later fresh report and the staging window; it never sends another command', async () => {
    await schedule(); failPublish = Object.assign(new Error('write uncertain'), { statusCode: 504 });
    const body = { requestId: randomUUID(), revision: 1 }; await controls.applyTimer(ID, '15', body);
    const proof = { observedBootId: 'abcdef01', observedSerial: 1 };
    await expect(controls.resolve(ID, body.requestId, proof)).rejects.toMatchObject({ statusCode: 409 });
    clock.ms += 31000; await state({ serial: 2 });
    await expect(controls.resolve(ID, body.requestId, proof)).rejects.toMatchObject({ statusCode: 409 });
    await controls.resolve(ID, body.requestId, { ...proof, observedSerial: 2 });
    expect((await controls.applyTimer(ID, '15', body)).outcome).toBe('resolved_not_applied');
    expect(calls).toEqual([]);
  });
  test('server replies only after explicit enrollment, once per boot, never for a retained request', async () => {
    await profile(); await state();
    controls.handleMessage('esp32/config', Buffer.from(ID)); await controls.drain(); expect(calls).toEqual([]);
    const body = { requestId: randomUUID(), revision: 1, restoreOnBoot: true };
    await controls.applyProfile(ID, body); await state({ serial: 2 });
    controls.handleMessage('esp32/config', Buffer.from(ID), { retain: true }); await controls.drain(); expect(calls).toHaveLength(1);
    await state({ bootId: 'abcdef02', serial: 1 });
    controls.handleMessage('esp32/config', Buffer.from(ID)); await controls.drain(); expect(calls).toHaveLength(2);
    await state({ bootId: 'abcdef02', serial: 2 });
    controls.handleMessage('esp32/config', Buffer.from(ID)); await controls.drain(); expect(calls).toHaveLength(2);
  });
  test('a crash after the durable fence but before receipt insertion preserves identity and can be reconciled without sending', async () => {
    await schedule();
    const insert = jest.spyOn(Object.getPrototypeOf(db.collection(OPERATIONS)), 'insertOne').mockRejectedValueOnce(Error('Synthetic interrupted insert'));
    const body = { requestId: randomUUID(), revision: 1 };
    await expect(controls.applyTimer(ID, '15', body)).rejects.toThrow('Synthetic interrupted insert');
    insert.mockRestore();
    expect((await controls.read(ID)).operation).toMatchObject({ id: body.requestId, outcome: 'dispatching' });
    expect((await controls.applyTimer(ID, '15', body)).outcome).toBe('dispatching');
    clock.ms += 31000; await state({ serial: 2 });
    await controls.resolve(ID, body.requestId, { observedBootId: 'abcdef01', observedSerial: 2 });
    expect((await controls.applyTimer(ID, '15', body)).outcome).toBe('resolved_not_applied');
    expect(calls).toEqual([]);
  });
  test('a matching report cannot release the fence while the original publication is still running', async () => {
    await profile(); await state();
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    controls = createControls({ db, now: () => new Date(clock.ms), seen: () => true, deviceOr404: async () => device,
      monitor: { status: () => link, publish: async message => {
        calls.push(message); entered(); await new Promise(resolve => { release = resolve; });
        return { publishedAt: new Date(clock.ms).toISOString() };
      } } });
    const body = { requestId: randomUUID(), revision: 1, restoreOnBoot: true };
    const running = controls.applyProfile(ID, body); await started;
    clock.ms += 31000; await state({ serial: 2 });
    expect((await controls.read(ID)).inFlight).toBe(body.requestId);
    await expect(controls.resolve(ID, body.requestId, { observedBootId: 'abcdef01', observedSerial: 2 })).rejects.toMatchObject({ statusCode: 409 });
    release(); expect((await running).outcome).toBe('acknowledged');
    expect((await controls.read(ID)).restoreOnBoot).toBe(true);
    expect(calls).toHaveLength(1);
  });
  test('HTTP routes use the canonical IoT owner and validate before writes', async () => {
    iot._reset(); const app = express(); app.use(express.json()); app.locals.db = db;
    app.use('/api/v1/iot', require('../../routes/iot.routes'));
    await request(app).put('/api/v1/iot/profiles/HTTP').send({ revision: 0, config: [pin] }).expect(200);
    await request(app).get('/api/v1/iot/profiles').expect(200);
    await request(app).put('/api/v1/iot/profiles/HTTP').send({ revision: 0, config: [pin] }).expect(409);
    await request(app).get('/api/v1/iot/devices/UNKNOWN/controls').expect(404);
  });
});
