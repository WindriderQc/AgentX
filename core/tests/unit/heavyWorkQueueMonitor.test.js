'use strict';
jest.mock('../../src/services/heavyWorkQueueService', () => ({ list: jest.fn() }));
jest.mock('../../src/services/heavyWorkQueueEvidence', () => ({ reconcile: jest.fn() }));
jest.mock('../../src/services/images/imageService', () => ({ dispatchQueued: jest.fn() }));
jest.mock('../../src/services/heavyWorkQueueNotifications', () => ({ publishJobs: jest.fn() }));
const queue = require('../../src/services/heavyWorkQueueService');
const evidence = require('../../src/services/heavyWorkQueueEvidence');
const images = require('../../src/services/images/imageService');
const notices = require('../../src/services/heavyWorkQueueNotifications');
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
