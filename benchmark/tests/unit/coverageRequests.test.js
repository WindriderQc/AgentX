'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/clients/coreModelHostApi', () => ({ getDedicationStatuses: jest.fn() }));
jest.mock('../../src/clients/coreCoverageReads', () => ({
  getRoutingConfig: jest.fn(), getRuntimeActive: jest.fn(), getHouseholdIdle: jest.fn()
}));

const { requestMeasurement, cancelRequest, recentResults, cellKey } = require('../../src/services/measurementCoverage/coverageRequests');
const { orderCells } = require('../../src/services/measurementCoverage/coverageJob');

const cell = (over = {}) => ({
  hostId: 'cpu-a', hostUrl: 'http://cpu-a:11435', hostName: 'CPU A', residency: 'cpu', model: 'small:26b',
  profile: { state: 'current' }, catalog: { total: 10, covered: 4 }, next: 'benchmark', ...over
});

function harness(cells, state = { last: null, cells: {}, requests: {} }) {
  const store = { getState: jest.fn(async () => state), saveState: jest.fn(async value => value) };
  return { deps: { store, buildCoverage: async () => ({ cells }) }, store, state };
}

describe('coverage requests', () => {
  it('queues a pair named by host id, name or address, with its reason', async () => {
    const { deps, state, store } = harness([cell()]);
    const queued = await requestMeasurement({ host: 'CPU A', model: 'Small:26b', reason: '  new   artifact  ', priority: 3, requestedBy: 'mcp-agent' }, deps);
    expect(queued).toMatchObject({ host: 'CPU A', model: 'small:26b', next: 'benchmark', request: { priority: 3, reason: 'new artifact', requestedBy: 'mcp-agent' } });
    expect(queued.note).toContain('quiet hours');
    expect(state.requests[cellKey(cell())]).toMatchObject({ priority: 3 });
    expect(store.saveState).toHaveBeenCalledTimes(1);
    await requestMeasurement({ host: 'http://cpu-a:11435/', model: 'small:26b', reason: 'again' }, deps);
    expect(state.requests[cellKey(cell())]).toMatchObject({ priority: 2, requestedBy: 'operator' });
  });

  it.each([
    [{ host: 'CPU A', model: 'small:26b' }, 'COVERAGE_REQUEST_INVALID'],
    [{ host: 'CPU A', model: 'small:26b', reason: 'x'.repeat(301) }, 'COVERAGE_REQUEST_INVALID'],
    [{ host: 'CPU A', model: 'small:26b', reason: 'why', priority: 5 }, 'COVERAGE_REQUEST_INVALID'],
    [{ host: 'Nowhere', model: 'small:26b', reason: 'why' }, 'COVERAGE_PAIR_UNKNOWN'],
    [{ host: 'CPU A', model: 'ghost:1b', reason: 'why' }, 'COVERAGE_PAIR_UNKNOWN']
  ])('refuses %j', async (input, code) => {
    const { deps, store } = harness([cell()]);
    await expect(requestMeasurement(input, deps)).rejects.toMatchObject({ code });
    expect(store.saveState).not.toHaveBeenCalled();
  });

  it('refuses a pair that is already complete, and withdraws a request', async () => {
    const done = harness([cell({ next: null })]);
    await expect(requestMeasurement({ host: 'cpu-a', model: 'small:26b', reason: 'why' }, done.deps)).rejects.toMatchObject({ code: 'COVERAGE_PAIR_COMPLETE' });
    const { deps, state } = harness([cell()], { last: null, cells: {}, requests: { [cellKey(cell())]: { priority: 2 } } });
    await expect(cancelRequest({ host: 'cpu-a', model: 'small:26b' }, deps)).resolves.toMatchObject({ cancelled: true });
    expect(state.requests).toEqual({});
    await expect(cancelRequest({ host: 'cpu-a', model: 'small:26b' }, deps)).resolves.toMatchObject({ cancelled: false });
  });

  it('moves requested pairs to the front, most urgent then oldest first', () => {
    const a = cell({ hostUrl: 'http://a:1', catalog: { total: 10, covered: 0 } });
    const b = cell({ hostUrl: 'http://b:1', catalog: { total: 10, covered: 9 } });
    const c = cell({ hostUrl: 'http://c:1', catalog: { total: 10, covered: 5 } });
    const d = cell({ hostUrl: 'http://d:1', next: 'profile', profile: { state: 'missing' } });
    const state = { cells: {}, requests: {
      [cellKey(b)]: { priority: 2, at: '2030-01-01T00:00:00Z' },
      [cellKey(c)]: { priority: 2, at: '2030-01-02T00:00:00Z' },
      [cellKey(a)]: { priority: 3, at: '2030-01-03T00:00:00Z' }
    } };
    expect(orderCells([d, c, b, a], state, 0).map(item => item.hostUrl)).toEqual(['http://a:1', 'http://b:1', 'http://c:1', 'http://d:1']);
  });

  it('returns recent scores of a pair without answer text', async () => {
    const { deps } = harness([cell()]);
    const findResults = jest.fn(async () => [
      { prompt_name: 'One', prompt_category: 'agent', prompt_level: 1, quality_score: 8, scoring_method: 'llm', success: true,
        tokens: 100, tokens_per_sec: 11.5, latency: 9400, timestamp: 't1', scorer_version: '9', response: 'secret text' },
      { prompt_name: 'Two', prompt_category: 'agent', prompt_level: 2, quality_score: null, scoring_method: 'llm_failed', success: true,
        error: 'Decomposed judge calls failed', timestamp: 't2' },
      { prompt_name: 'Three', prompt_category: 'coding', quality_score: 4, success: false, excluded_from_leaderboard: true, timestamp: 't3' }
    ]);
    const data = await recentResults({ host: 'cpu-a', model: 'small:26b', limit: '2' }, { ...deps, findResults });
    expect(findResults).toHaveBeenCalledWith({ host: { $in: ['http://cpu-a:11435', 'http://cpu-a:11435/'] }, model: { $in: ['small:26b', 'small:26b'] } });
    expect(data.summary).toEqual({ scored: 2, unscored: 1, meanScore: 6, failed: 1 });
    expect(data.results[0]).toEqual({ prompt: 'One', category: 'agent', level: 1, score: 8, scored: true, scoringMethod: 'llm', success: true,
      error: null, tokens: 100, tokensPerSec: 11.5, seconds: 9, at: 't1', scorerVersion: '9', excluded: false });
    expect(data.results[1]).toMatchObject({ scored: false, score: null, error: 'Decomposed judge calls failed' });
    expect(JSON.stringify(data)).not.toContain('secret text');
  });
});
