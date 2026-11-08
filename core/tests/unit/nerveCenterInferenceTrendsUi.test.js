'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/nerve-center-inference.js'), 'utf8');

async function render(buckets) {
  const body = { innerHTML: '' };
  const trends = { innerHTML: '' };
  const charts = [];
  const errors = { warn: jest.fn(), error: jest.fn() };
  const context = {
    console: errors,
    Chart: function (_canvas, config) { charts.push(config); },
    document: { getElementById: id => ({
      sectionInferenceBody: body,
      'nc-inference-trends': trends,
      'nc-throughput-chart': { getContext: () => ({}) },
      'nc-latency-chart': { getContext: () => ({}) }
    }[id] || null) },
    window: {
      PollingController: class { start() {} removeTask() {} addTask() {} },
      NerveCenterShared: {
        fetchJson: async url => ({ data: url.startsWith('/api/telemetry/timeline')
          ? buckets : url.startsWith('/api/telemetry/') ? [] : {} }),
        escapeHtml: value => String(value),
        renderSectionLoading() {}, renderSectionError: errors.error,
        attachCollapsibleHandlers() {}, finishSectionLoad() {}
      }
    }
  };
  vm.runInNewContext(source, context);
  await context.window.NerveCenterInference.loadInference();
  await new Promise(resolve => setImmediate(resolve));
  expect(errors.warn).not.toHaveBeenCalled();
  expect(errors.error).not.toHaveBeenCalled();
  return { html: trends.innerHTML, latency: charts.find(chart => chart.type === 'line') };
}

test('trends plot full latency and null gaps while labelling the long-call threshold as descriptive', async () => {
  const { html, latency } = await render([
    { bucket: '2026-11-01T01:00:00Z', avgLatencyMs: 105000, p95LatencyMs: 120000,
      longCallCount: 2, longCallMaxMs: 120000, unmeasuredDurationCount: 1 },
    { bucket: '2026-11-01T02:00:00Z', avgLatencyMs: null, p95LatencyMs: null,
      longCallCount: 0, longCallMaxMs: null, unmeasuredDurationCount: 0 }
  ]);
  expect(latency.data.datasets.map(dataset => Array.from(dataset.data))).toEqual([[105000, null], [120000, null]]);
  expect(html).toContain('2 calls ≥60s included (max 120,000ms).');
  expect(html).toContain('1 call without measured duration.');
  expect(html).toContain('including errors and timeouts');
  expect(html).toContain('Duration alone does not establish a cold start.');
  expect(html).not.toContain('suspected cold start');
  expect(html).not.toContain('excluded');
});

test('trends say no measured long calls when all durations are unknown', async () => {
  const { html, latency } = await render([{
    bucket: '2026-11-01T01:00:00Z', avgLatencyMs: null, p95LatencyMs: null,
    longCallCount: 0, longCallMaxMs: null, unmeasuredDurationCount: 2
  }]);
  expect(html).toContain('No measured calls ≥60s in this window.');
  expect(html).toContain('2 calls without measured duration.');
  expect(latency.data.datasets.map(dataset => Array.from(dataset.data))).toEqual([[null], [null]]);
});
