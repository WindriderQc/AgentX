'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const toolbox = require('../index');
const pin = { io: 15, mode: 'OUT', lbl: 'D15', isA: false, name: 'Lamp' };
async function fixture(t, respond) {
  const original = global.fetch, calls = [];
  t.after(() => { global.fetch = original; });
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return respond ? respond() : { status: 200, text: async () => JSON.stringify({ status: 'success', data: {} }) };
  };
  const app = express(); app.use(express.json()); toolbox.register({ contractVersion: 2, app, express });
  return { app, calls };
}
test('profile and timer relays preserve canonical schemas and reject injection before dispatch', async t => {
  const { app, calls } = await fixture(t);
  const base = '/api/data-toolbox/iot';
  await request(app).put(`${base}/profiles/Grow`).send({ revision: 0, config: [pin] }).expect(200);
  await request(app).put(`${base}/devices/SYN_1/profile`).send({ revision: 0, profileName: 'Grow', profileRevision: 1 }).expect(200);
  await request(app).post(`${base}/devices/SYN_1/profile/apply`).send({ requestId: randomUUID(), revision: 1, restoreOnBoot: false }).expect(200);
  await request(app).put(`${base}/devices/SYN_1/timers/15`).send({ revision: 1, io: 15, tStart: '23:00:00', tStop: '06:00:00', enabled: true }).expect(200);
  await request(app).post(`${base}/devices/SYN_1/timers/15/apply`).send({ requestId: randomUUID(), revision: 2 }).expect(200);
  for (const body of [{ revision: 0, config: [pin], retain: true }, { revision: 0, config: [{ ...pin, isA: '0' }] }, { revision: '0', config: [pin] }])
    await request(app).put(`${base}/profiles/Bad`).send(body).expect(400);
  await request(app).post(`${base}/devices/SYN_1/timers/1e1/apply`).send({ requestId: randomUUID(), revision: 2 }).expect(400);
  await request(app).post(`${base}/devices/SYN_1/profile/apply`).send({ requestId: randomUUID(), revision: 1, restoreOnBoot: false, topic: 'other/device' }).expect(400);
  assert.equal(calls.length, 5);
  assert.deepEqual(JSON.parse(calls[0].options.body), { revision: 0, config: [pin] });
  assert.equal(new URL(calls[4].url).pathname, '/api/v1/iot/devices/SYN_1/timers/15/apply');
});
test('an upstream refusal survives and a lost reply is unknown without a second dispatch', async t => {
  let lost = false;
  const { app, calls } = await fixture(t, () => {
    if (lost) throw Error('transport lost');
    return { status: 503, text: async () => JSON.stringify({ status: 'error', message: 'Nothing was sent or queued' }) };
  });
  const url = '/api/data-toolbox/iot/devices/SYN_1/profile/apply';
  const body = { requestId: randomUUID(), revision: 1, restoreOnBoot: false };
  assert.match((await request(app).post(url).send(body).expect(503)).body.message, /Nothing was sent/);
  lost = true;
  assert.match((await request(app).post(url).send(body).expect(502)).body.message, /outcome unknown/);
  assert.equal(calls.length, 2);
});
