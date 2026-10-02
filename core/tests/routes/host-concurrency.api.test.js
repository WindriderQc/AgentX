'use strict';

const express = require('express');
const request = require('supertest');
const HostPreference = require('../../models/HostPreference');
const createRouter = require('../../routes/nerve-center-host-concurrency');

const hostUrl = 'http://host.example:11434';
const endpoint = '/host-preferences/' + encodeURIComponent(hostUrl) + '/ollama-concurrency';
const app = express();
app.use(express.json());
app.use(createRouter(req => req.params.hostUrl));

beforeEach(async () => {
  await HostPreference.deleteMany({});
  await HostPreference.create({ hostUrl, hostKey: 'primary', maxConcurrentModels: 2,
    pinnedModels: [{ model: 'conversation:latest' }, { model: 'embedding:latest' }] });
});

it('records a dated process observation while preserving pins and residency intent', async () => {
  const observedAt = new Date().toISOString();
  const response = await request(app).put(endpoint).send({ numParallel: 4, observedAt,
    source: 'startup-log', pinnedModels: [], maxConcurrentModels: 4 }).expect(200);
  expect(response.body.data.ollamaConcurrency).toEqual({ numParallel: 4, observedAt, source: 'startup-log' });
  const stored = await HostPreference.findOne({ hostUrl }).lean();
  expect(stored.maxConcurrentModels).toBe(2);
  expect(stored.pinnedModels.map(pin => pin.model)).toEqual(['conversation:latest', 'embedding:latest']);
});

it.each([
  { numParallel: 0 }, { numParallel: 1.5 }, { numParallel: '4' },
  { observedAt: 'invalid' }, { observedAt: new Date(Date.now() + 86400000).toISOString() },
  { source: 'guessed-default' }
])('rejects unverified or invalid observations without writing (%j)', async override => {
  await request(app).put(endpoint).send({ numParallel: 4, observedAt: new Date().toISOString(),
    source: 'process-environment', ...override }).expect(400);
  expect((await HostPreference.findOne({ hostUrl }).lean()).ollamaConcurrency).toBeNull();
});

it('keeps an unobserved host unknown and refuses observations for an unknown host', async () => {
  const pref = await HostPreference.findOne({ hostUrl }).lean();
  expect(pref.ollamaConcurrency).toBeNull();
  await HostPreference.deleteMany({});
  await request(app).put(endpoint).send({ numParallel: 1, observedAt: new Date().toISOString(),
    source: 'process-environment' }).expect(404);
  expect(await HostPreference.countDocuments()).toBe(0);
});
