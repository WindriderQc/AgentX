'use strict';
jest.mock('../../src/services/heavyWorkQueueService', () => ({ list: jest.fn() }));
jest.mock('../../src/services/heavyWorkQueueEvidence', () => ({ reconcile: jest.fn() }));
jest.mock('../../src/services/images/imageService', () => ({ dispatchQueued: jest.fn() }));
jest.mock('../../src/services/heavyWorkQueueNotifications', () => ({ publishJobs: jest.fn() }));
const queue = require('../../src/services/heavyWorkQueueService');
const evidence = require('../../src/services/heavyWorkQueueEvidence');
const images = require('../../src/services/images/imageService');
const notices = require('../../src/services/heavyWorkQueueNotifications');
jest.mock('../../src/services/transcriptionExecutor', () => ({ heartbeatActive: jest.fn(async () => ({ renewed: 0, refused: 0 })) }));
const monitor = require('../../src/services/heavyWorkQueueMonitor');
test('an unavailable image configuration cannot block Benchmark/Profiler receipts or the result inbox', async () => {
  const jobs = [{ id: 'synthetic-benchmark', state: 'running' }, { id: 'synthetic-profiler', state: 'uncertain' }, { id: 'unstarted', state: 'requested' }];
  queue.list.mockResolvedValue({ jobs });
  images.dispatchQueued.mockRejectedValue(new Error('Synthetic missing image configuration'));
  evidence.reconcile.mockResolvedValue({});
  await monitor.sweep();
  expect(evidence.reconcile.mock.calls.map(call => call[0])).toEqual(['synthetic-benchmark', 'synthetic-profiler']);
  expect(notices.publishJobs).toHaveBeenCalledWith(jobs);
});

test('startup and Mongo reconnect renew persisted admissions immediately and stop removes the listener', () => {
  const mongoose = require('mongoose');
  const executor = require('../../src/services/transcriptionExecutor');
  const before = mongoose.connection.listenerCount('connected');
  const originalEnvironment = process.env.NODE_ENV;
  executor.heartbeatActive.mockClear();
  try {
    process.env.NODE_ENV = 'production';
    monitor.start();
    expect(executor.heartbeatActive).toHaveBeenCalledTimes(1);
    mongoose.connection.emit('connected');
    expect(executor.heartbeatActive).toHaveBeenCalledTimes(2);
    expect(mongoose.connection.listenerCount('connected')).toBe(before + 1);
    monitor.stop();
    mongoose.connection.emit('connected');
    expect(executor.heartbeatActive).toHaveBeenCalledTimes(2);
    expect(mongoose.connection.listenerCount('connected')).toBe(before);
  } finally { monitor.stop(); process.env.NODE_ENV = originalEnvironment; }
});
