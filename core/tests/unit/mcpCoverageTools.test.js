'use strict';

const { COVERAGE_TOOLS, COVERAGE_TOOL_HANDLERS } = require('../../src/services/mcpCoverageTools');
const { callTool, TOOLS } = require('../../src/services/mcpSkillBus');

const cell = {
  hostId: 'cpu-a', hostName: 'CPU A', hostUrl: 'http://cpu-a:11435', residency: 'cpu', model: 'small:26b', pinned: true, tasks: ['ops_watch'],
  profile: { state: 'current', depth: 'standard', reason: null },
  catalog: { total: 10, covered: 4, byCategory: { agent: { total: 10, covered: 4 } } },
  missingPromptIds: ['p5'], artifact: { digest: 'aaa' }, complete: false, next: 'benchmark', request: null,
};

describe('coverage tools on the MCP bus', () => {
  it('are listed with the rest of the bus, two of them read-only', () => {
    const names = TOOLS.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(COVERAGE_TOOLS.map(tool => tool.name)));
    expect(COVERAGE_TOOLS.map(tool => [tool.name, tool.annotations.readOnlyHint])).toEqual([
      ['benchmark_coverage', true], ['benchmark_results', true], ['benchmark_request_measurement', false]]);
  });

  it('reads the matrix as pairs and says what the job is waiting for', async () => {
    const benchmarkRequest = jest.fn(async () => ({ status: 'success', data: {
      generatedAt: 'now', scorerVersion: '9.9.9', summary: { cells: 1, percent: 40 }, cells: [cell],
      job: { settings: { enabled: true, quietStart: '01:00', quietEnd: '06:00', timeZone: 'UTC' },
        lastCheck: { idle: false, reasons: ['outside quiet hours'] }, last: null } } }));
    const view = await COVERAGE_TOOL_HANDLERS.benchmark_coverage({}, { benchmarkRequest });
    expect(benchmarkRequest).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/benchmark/coverage' }));
    expect(view.pairs).toEqual([{
      host: 'CPU A', hostId: 'cpu-a', residency: 'cpu', model: 'small:26b', pinned: true, routedTasks: ['ops_watch'],
      profile: 'current', profileDepth: 'standard', profileNote: null, promptsScored: 4, promptsTotal: 10,
      byCategory: { agent: { total: 10, covered: 4 } }, complete: false, next: 'benchmark', request: null }]);
    expect(view.automaticMeasurement).toEqual({ enabled: true, quietHours: '01:00 to 06:00 (UTC)', waitingFor: ['outside quiet hours'], last: null });
    expect(JSON.stringify(view)).not.toContain('missingPromptIds');
  });

  it('reads recent results of one pair', async () => {
    const benchmarkRequest = jest.fn(async () => ({ data: { count: 0, results: [] } }));
    await COVERAGE_TOOL_HANDLERS.benchmark_results({ host: ' cpu-a ', model: 'small:26b', limit: 500 }, { benchmarkRequest });
    expect(benchmarkRequest).toHaveBeenCalledWith(expect.objectContaining({
      path: '/api/benchmark/coverage/results', query: { host: 'cpu-a', model: 'small:26b', limit: 100 } }));
    await expect(COVERAGE_TOOL_HANDLERS.benchmark_results({ host: 'cpu-a' }, { benchmarkRequest })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
  });

  it('requests a measurement with a reason, and can withdraw it', async () => {
    const benchmarkRequest = jest.fn(async () => ({ data: { note: 'Queued.' } }));
    await COVERAGE_TOOL_HANDLERS.benchmark_request_measurement({ host: 'cpu-a', model: 'small:26b', reason: ' new artifact ', priority: 3 }, { benchmarkRequest });
    expect(benchmarkRequest).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/api/benchmark/coverage/requests', method: 'POST',
      body: { host: 'cpu-a', model: 'small:26b', reason: 'new artifact', requestedBy: 'mcp-agent', priority: 3 } }));
    await COVERAGE_TOOL_HANDLERS.benchmark_request_measurement({ host: 'cpu-a', model: 'small:26b', cancel: true }, { benchmarkRequest });
    expect(benchmarkRequest).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'DELETE', body: { host: 'cpu-a', model: 'small:26b' } }));
    for (const bad of [{ host: 'cpu-a', model: 'small:26b' }, { host: 'cpu-a', model: 'small:26b', reason: 'x', priority: 9 }]) {
      await expect(COVERAGE_TOOL_HANDLERS.benchmark_request_measurement(bad, { benchmarkRequest })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    }
  });

  it('returns Benchmark\'s refusal as the tool answer', async () => {
    const benchmarkRequest = jest.fn(async () => {
      throw Object.assign(new Error('HTTP 404'), { status: 404, body: { code: 'COVERAGE_PAIR_UNKNOWN', message: 'not in the coverage scope' } });
    });
    const result = await callTool({ name: 'benchmark_request_measurement', arguments: { host: 'x', model: 'y', reason: 'check' } }, { benchmarkRequest });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('not in the coverage scope');
  });
});
