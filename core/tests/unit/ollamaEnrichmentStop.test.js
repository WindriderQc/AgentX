'use strict';

const mockGetConfiguredHosts = jest.fn(() => []);
jest.mock('../../src/helpers/ollamaHostConfig', () => ({ getConfiguredHosts: mockGetConfiguredHosts }));

const enrichment = require('../../src/services/ollamaEnrichmentService');

afterEach(() => {
  enrichment.stop();
  jest.useRealTimers();
});

test('stop before the delayed first poll cancels it (#17)', () => {
  jest.useFakeTimers();
  enrichment.start(60_000);
  enrichment.stop();
  jest.advanceTimersByTime(120_000);
  expect(mockGetConfiguredHosts).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

test('without stop the delayed first poll still runs', () => {
  jest.useFakeTimers();
  enrichment.start(60_000);
  jest.advanceTimersByTime(5_000);
  expect(mockGetConfiguredHosts).toHaveBeenCalledTimes(1);
});
