'use strict';

const request = require('supertest');
const express = require('express');
jest.mock('../../utils/logger', () => ({ log: jest.fn(), logger: { warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../utils/fetch-utils', () => ({ fetchWithTimeoutAndRetry: jest.fn() }));
jest.mock('../../services/activityEvents', () => ({ feedRun: jest.fn() }));
jest.mock('../../services/mqttClient', () => ({ unsubscribeAll: jest.fn(), close: jest.fn() }));

const { fetchWithTimeoutAndRetry: fetchPage } = require('../../utils/fetch-utils');
const liveData = require('../../services/liveData');
const cityWeather = require('../../services/livedata/ecCityPage');
const routes = require('../../routes/livedata.routes');

const start = Date.parse('2026-01-01T08:00:00Z');
const observedAt = '2026-01-01T07:00:00Z';
const forecastIssuedAt = '2026-01-01T06:00:00Z';
const page = { json: async () => ({ features: [{
  geometry: { coordinates: [-70, 47] },
  properties: { currentConditions: { timestamp: observedAt, temperature: { value: 0 } },
    forecastGroup: { timestamp: forecastIssuedAt } }
}] }) };

function instance() {
  const switches = { liveDataEnabled: true, weather: true };
  const db = { collection(name) {
    return {
      updateOne: async () => {},
      findOne: async () => ({ lat: 47, lon: -70 }),
      find: () => ({ toArray: async () => name === 'livedataconfigs'
        ? Object.entries(switches).map(([service, enabled]) => ({ service, enabled })) : [] })
    };
  } };
  const app = express();
  app.locals.db = db;
  app.use('/api/v1/livedata', routes);
  const read = (query = 'prepared=1') => request(app).get('/api/v1/livedata/ec-weather?' + query).expect(200);
  return { db, switches, read };
}

beforeEach(() => {
  jest.replaceProperty(process, 'env', { ...process.env, LIVEDATA_EC_WEATHER_PREPARE_ENABLED: 'true' });
  jest.useFakeTimers({ now: start, doNotFake: ['nextTick', 'setImmediate'] });
  cityWeather._cache.clear();
  fetchPage.mockReset().mockResolvedValue(page);
});
afterEach(async () => {
  await liveData.close();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('the ordinary weather feed alone leaves the EC bulletin on demand', async () => {
  delete process.env.LIVEDATA_EC_WEATHER_PREPARE_ENABLED;
  const { db, read } = instance();
  await liveData.init(db);
  await jest.advanceTimersByTimeAsync(12 * 60_000);
  expect((await read()).body.data.preparedStatus).toBe('missing');
  expect(fetchPage).not.toHaveBeenCalled();
  expect((await read('lang=fr')).body.data.current.temperatureC).toBe(0);
  expect((await read()).body.data.preparedStatus).toBe('fresh');
  expect(fetchPage).toHaveBeenCalledTimes(1);
});

test('prepares the configured French bulletin without a request and shares it across reads and config reloads', async () => {
  const { db, read } = instance();
  expect((await read()).body.data).toMatchObject({ preparedStatus: 'missing', cached: false, fetchedAt: null });
  expect(fetchPage).not.toHaveBeenCalled();
  await liveData.init(db);
  await jest.advanceTimersByTimeAsync(0);
  expect(fetchPage).toHaveBeenCalledTimes(1);
  const prepared = (await read()).body.data;
  expect(prepared).toMatchObject({ preparedStatus: 'fresh', cached: true, fetchedAt: new Date(start).toISOString(),
    current: { temperatureC: 0, observedAt }, forecastIssuedAt });
  expect(prepared.warnings).toBeNull();
  const screen = (await read('lang=fr')).body.data;
  expect(screen.current).toEqual(prepared.current);
  expect(screen.warnings).toEqual([]);
  expect((await read('lang=en&prepared=1')).body.data.preparedStatus).toBe('missing');
  expect((await read('lat=48&lon=-70&prepared=1')).body.data.preparedStatus).toBe('missing');
  await liveData.reloadConfig();
  expect(fetchPage).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(9 * 60_000);
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect((await read()).body.data.fetchedAt).toBe(new Date(start + 9 * 60_000).toISOString());
});

test('shares an in-flight miss and reports a stale bulletin after a refresh failure', async () => {
  const { db, read } = instance();
  let finish;
  fetchPage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await liveData.init(db);
  await jest.advanceTimersByTimeAsync(0);
  expect((await read()).body.data.preparedStatus).toBe('missing');
  const concurrent = cityWeather.getCityWeather({ lat: 47, lon: -70 });
  expect(fetchPage).toHaveBeenCalledTimes(1);
  finish(page);
  await concurrent;
  fetchPage.mockRejectedValue(new Error('upstream unavailable'));
  await jest.advanceTimersByTimeAsync(10 * 60_000);
  const afterFailure = fetchPage.mock.calls.length;
  expect((await read()).body.data).toMatchObject({ preparedStatus: 'stale', fetchedAt: new Date(start).toISOString(),
    current: { observedAt } });
  expect(fetchPage).toHaveBeenCalledTimes(afterFailure);
  fetchPage.mockResolvedValue(page);
  await jest.advanceTimersByTimeAsync(60_000);
  expect((await read()).body.data.preparedStatus).toBe('fresh');
});

test('a backward clock correction does not extend the retry hold from an earlier failed fetch', async () => {
  const { db, read } = instance();
  fetchPage.mockRejectedValueOnce(new Error('upstream unavailable'));
  await liveData.init(db);
  await jest.advanceTimersByTimeAsync(0);
  expect((await read()).body.data.preparedStatus).toBe('missing');
  jest.setSystemTime(start - 60 * 60_000);
  await jest.advanceTimersByTimeAsync(60_000);
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect((await read()).body.data.preparedStatus).toBe('fresh');
});

test('schedules only with both switches and stops refreshes on disable and close', async () => {
  const { switches, db } = instance();
  switches.weather = false;
  await liveData.init(db);
  await jest.advanceTimersByTimeAsync(12 * 60_000);
  expect(fetchPage).not.toHaveBeenCalled();
  switches.weather = true;
  await liveData.reloadConfig();
  await jest.advanceTimersByTimeAsync(0);
  expect(fetchPage).toHaveBeenCalledTimes(1);
  switches.liveDataEnabled = false;
  await liveData.reloadConfig();
  await jest.advanceTimersByTimeAsync(20 * 60_000);
  expect(fetchPage).toHaveBeenCalledTimes(1);
  switches.liveDataEnabled = true;
  await liveData.reloadConfig();
  await jest.advanceTimersByTimeAsync(0);
  expect(fetchPage).toHaveBeenCalledTimes(2);
  await liveData.close();
  await jest.advanceTimersByTimeAsync(20 * 60_000);
  expect(fetchPage).toHaveBeenCalledTimes(2);
});

test('a delayed config read cannot start the producer after shutdown', async () => {
  const { db, switches } = instance();
  switches.weather = false;
  await liveData.init(db);
  const getCollection = db.collection;
  let completeRead;
  db.collection = name => name === 'livedataconfigs' ? {
    find: () => ({ toArray: () => new Promise(resolve => { completeRead = resolve; }) })
  } : getCollection(name);
  const reload = liveData.reloadConfig();
  await liveData.close();
  completeRead([{ service: 'liveDataEnabled', enabled: true }, { service: 'weather', enabled: true }]);
  await reload;
  await jest.advanceTimersByTimeAsync(20 * 60_000);
  expect(fetchPage).not.toHaveBeenCalled();
});

test('a late settings update cannot restart preparation after Data has stopped', async () => {
  const { db } = instance();
  await liveData.init(db);
  await jest.advanceTimersByTimeAsync(0);
  const calls = fetchPage.mock.calls.length;
  await liveData.close();
  await liveData.reloadConfig();
  await jest.advanceTimersByTimeAsync(10 * 60_000);
  expect(fetchPage).toHaveBeenCalledTimes(calls);
  expect(liveData.isRunning()).toBe(false);
});
