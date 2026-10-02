'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const window = { NerveCenterShared: { escapeHtml: value => String(value ?? '').replace(/</g, '&lt;') } };
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../public/js/nerve-center-gpu-health.js'), 'utf8'), { window, Date });
const render = window.NerveCenterGpuHealth.render;
test.each([null, new Date(Date.now() - 120000).toISOString(), new Date(Date.now() + 120000).toISOString()])('does not paint stale, future or absent GPU evidence green', checkedAt => {
  const html = render({ status: 'healthy', checkedAt, entries: [{ model: 'synthetic-model', loaded: true, status: 'full' }] });
  expect(html).toContain('data-gpu-health="unknown"');
  expect(html).not.toContain('Pins fully on GPU');
});
test('shows per-pin CPU degradation beside a separate HTTP observation', () => {
  const html = render({ status: 'degraded', checkedAt: new Date().toISOString(), reason: 'pinned_model_gpu_spill',
    entries: [{ model: '<synthetic-embedder>', loaded: true, status: 'cpu' }] });
  expect(html).toContain('GPU residency degraded'); expect(html).toContain('On CPU');
  expect(html).toContain('&lt;synthetic-embedder>');
  expect(html).toContain('HTTP reachability and GPU residency are separate');
});
test('runtime ownership keeps qualification unknown', () => {
  expect(render({ status: 'unknown', reason: 'runtime_owner_active', checkedAt: new Date().toISOString() })).toContain('Pin health is not qualified');
});
