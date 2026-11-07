'use strict';

jest.mock('node-fetch', () => jest.fn(() => { throw new Error('Unexpected runtime request'); }));

const mongoose = require('mongoose');
const request = require('supertest');
const app = require('express')();
app.use('/api/nerve-center', require('../../routes/nerve-center-self-healing'));
const routerDefaults = require('../../src/services/modelRouterDefaults');
const ladder = require('../../src/services/routing/taskFallbackLadder');
const watchdog = require('../../src/services/ollamaWatchdogService');
const daemon = require('../../src/services/hostHealthDaemon');
const reconciler = require('../../src/services/pinReconciler');
const alertService = require('../../src/services/alertService');
const watch = require('../../src/services/opsWatchService').getOpsWatch();
const notifications = require('../../src/services/notificationService').getNotificationService();

test('real default readers do not write, probe, schedule, notify or refresh routing state', async () => {
  const envBefore = { host: process.env.OLLAMA_HOST, ladders: process.env.AGENTX_TASK_FALLBACKS_JSON };
  const hostsBefore = { ...routerDefaults.HOSTS };
  const stateBefore = { daemon: daemon.getHealthCheckState(), watch: watch.state() };
  const actions = [[watchdog, 'runNow'], [watchdog, 'forceUnjam'], [watchdog, 'start'],
    [daemon, 'startHealthCheck'], [daemon, 'requestReconcile'], [reconciler, 'checkAndReloadDefaults'],
    [watch, 'check'], [watch, 'tick'], [watch, 'activate'], [notifications, 'send'],
    [alertService, 'evaluateEvent'], [alertService, 'loadRules'], [alertService, '_sendNotifications']];
  const blocked = actions.map(([owner, method]) => jest.spyOn(owner, method).mockImplementation(() => {
    throw new Error(`Read attempted action ${method}`);
  }));
  const writes = ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
    'replaceOne', 'findOneAndUpdate', 'findOneAndDelete', 'bulkWrite']
    .map(method => jest.spyOn(mongoose.Collection.prototype, method).mockImplementation(() => {
      throw new Error(`Read attempted database mutation ${method}`);
    }));
  const network = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected runtime request'));
  try {
    // The old stats getter refreshed HOSTS on its first uncached read.
    ladder._internal.resetForTests();
    process.env.OLLAMA_HOST = 'http://changed-synthetic.test:11434';
    process.env.AGENTX_TASK_FALLBACKS_JSON = '{}';
    for (let index = 0; index < 2; index++) {
      const response = await request(app).get('/api/nerve-center/self-healing').expect(200);
      expect(Object.values(response.body.data.sources).every(source => source.status === 'available')).toBe(true);
    }
    expect(routerDefaults.HOSTS).toEqual(hostsBefore);
    expect({ daemon: daemon.getHealthCheckState(), watch: watch.state() }).toEqual(stateBefore);
    [...blocked, ...writes, network, require('node-fetch')].forEach(spy => expect(spy).not.toHaveBeenCalled());
  } finally {
    [...blocked, ...writes, network].forEach(spy => spy.mockRestore());
    if (envBefore.host === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = envBefore.host;
    if (envBefore.ladders === undefined) delete process.env.AGENTX_TASK_FALLBACKS_JSON; else process.env.AGENTX_TASK_FALLBACKS_JSON = envBefore.ladders;
  }
});
