'use strict';

// Benchmark coverage tools for the Core MCP bus: what a lead agent needs to
// supervise measurement without running it. It reads the coverage matrix and
// recent scores, and may ask for a pair to be measured first. Benchmark alone
// decides when: a request waits for the quiet hours like everything else.
const { requestJson } = require('../helpers/crossServiceClient');

const REQUESTED_BY = 'mcp-agent';
const TIMEOUT_MS = 20000;

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const PAIR = {
  host: { type: 'string', minLength: 1, maxLength: 200, description: 'Host id or name as the coverage matrix lists it.' },
  model: { type: 'string', minLength: 1, maxLength: 200 },
};

const COVERAGE_TOOLS = [
  {
    name: 'benchmark_coverage',
    title: 'Benchmark Coverage',
    description: 'Read the coverage matrix: for each model pinned on a host or routed to it, whether its profile is current, how many catalog prompts have a scored answer per category, what it still needs, and what the automatic measurement job is doing or waiting for.',
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'benchmark_results',
    title: 'Benchmark Recent Results',
    description: 'Read the most recent scored answers of one host and model pair: prompt, category, score, whether the judge scored it, speed and errors. Use it to spot regressions, unscored answers and implausible speeds. Answer text is not returned.',
    inputSchema: objectSchema({ ...PAIR, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } }, ['host', 'model']),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'benchmark_request_measurement',
    title: 'Request A Measurement',
    description: 'Ask for one host and model pair to be measured before the others, with the reason. This only reorders the queue: Benchmark starts the measurement itself, in its quiet hours, when the runtime is idle. Pass cancel: true to withdraw a request.',
    inputSchema: objectSchema({
      ...PAIR,
      reason: { type: 'string', minLength: 1, maxLength: 300 },
      priority: { type: 'integer', enum: [1, 2, 3], default: 2, description: '3 is the most urgent.' },
      cancel: { type: 'boolean', default: false },
    }, ['host', 'model']),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function toolError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function plain(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw toolError('arguments must be an object', 'INVALID_ARGUMENTS');
  return args;
}

function pair(input) {
  for (const key of ['host', 'model']) {
    if (typeof input[key] !== 'string' || !input[key].trim()) throw toolError(`${key} is required`, 'INVALID_ARGUMENTS');
  }
  return { host: input.host.trim(), model: input.model.trim() };
}

async function benchmark(request, deps = {}) {
  try {
    const json = await (deps.benchmarkRequest || requestJson)({
      baseUrl: process.env.BENCHMARK_SERVICE_URL || 'http://localhost:3081',
      timeoutMs: TIMEOUT_MS, serviceName: 'benchmark', errorCode: 'BENCHMARK_COVERAGE_ERROR', ...request
    });
    return json?.data ?? json;
  } catch (error) {
    // Benchmark's own refusal (unknown pair, already complete) is the answer.
    const body = error.body && typeof error.body === 'object' ? error.body : null;
    throw toolError(body?.message || error.message, body?.code || error.code || 'BENCHMARK_COVERAGE_ERROR', error.status || 502);
  }
}

function cellView(cell) {
  return {
    host: cell.hostName, hostId: cell.hostId, residency: cell.residency, model: cell.model,
    pinned: cell.pinned, routedTasks: cell.tasks,
    profile: cell.profile.state, profileDepth: cell.profile.depth, profileNote: cell.profile.reason,
    promptsScored: cell.catalog.covered, promptsTotal: cell.catalog.total, byCategory: cell.catalog.byCategory,
    complete: cell.complete, next: cell.next, request: cell.request || null,
  };
}

async function coverage(_args, deps = {}) {
  const data = await benchmark({ path: '/api/benchmark/coverage' }, deps);
  const job = data.job || {};
  return {
    generatedAt: data.generatedAt, scorerVersion: data.scorerVersion, summary: data.summary,
    pairs: (data.cells || []).map(cellView),
    automaticMeasurement: {
      enabled: job.settings?.enabled === true,
      quietHours: job.settings ? `${job.settings.quietStart} to ${job.settings.quietEnd} (${job.settings.timeZone})` : null,
      waitingFor: job.lastCheck && !job.lastCheck.idle ? job.lastCheck.reasons : [],
      last: job.last || null,
    },
  };
}

async function results(args, deps = {}) {
  const input = plain(args);
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(input.limit)) || 30));
  return benchmark({ path: '/api/benchmark/coverage/results', query: { ...pair(input), limit } }, deps);
}

async function requestMeasurement(args, deps = {}) {
  const input = plain(args);
  if (input.cancel === true) return benchmark({ path: '/api/benchmark/coverage/requests', method: 'DELETE', body: pair(input) }, deps);
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) throw toolError('reason is required', 'INVALID_ARGUMENTS');
  if (input.priority !== undefined && ![1, 2, 3].includes(input.priority)) throw toolError('priority is 1, 2 or 3', 'INVALID_ARGUMENTS');
  return benchmark({ path: '/api/benchmark/coverage/requests', method: 'POST',
    body: { ...pair(input), reason, requestedBy: REQUESTED_BY, ...(input.priority === undefined ? {} : { priority: input.priority }) } }, deps);
}

module.exports = {
  COVERAGE_TOOLS,
  COVERAGE_TOOL_HANDLERS: { benchmark_coverage: coverage, benchmark_results: results, benchmark_request_measurement: requestMeasurement },
};
