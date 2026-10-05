'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const window = { NerveCenterShared: { escapeHtml: value => String(value ?? '').replace(/</g, '&lt;') } };
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../public/js/nerve-center-gpu-occupancy.js'), 'utf8'), { window });
const { render } = window.NerveCenterGpuOccupancy;

const sampled = {
  index: 0, name: 'Synthetic GPU', samples: 80, coverage: 0.667, missingMs: 20 * 60_000,
  busy: { share: 0.375 }, utilizationPct: { mean: 30 },
  memoryUsedMiB: { p95: 20_000, max: 20_480 }, memoryTotalMiB: 24_576,
  powerW: { mean: 237.5, p95: 300, limit: 350 }, throttled: { share: 0.125 },
  resource: { id: 'GPU-<a>', link: 'uuid', endpoints: ['http://gpu-a:11434', 'http://gpu-a:9000'] },
};
const unsampled = { index: 1, name: 'Synthetic GPU', samples: 0, coverage: 0, missingMs: 3_600_000, busy: { share: null } };

test('shows shares of covered time and names the missing time', () => {
  const html = render({ busyAtPct: 10, topology: 'configured', unlinkedResources: [],
    hosts: [{ name: 'GPU A', ollamaHostIds: ['primary'], gpus: [sampled, unsampled] }] });
  expect(html).toContain('38%'); // busy share
  expect(html).toContain('67% (80 samples · 20 min missing)');
  expect(html).toContain('19.5 / 24.0 GiB (max 20.0)');
  expect(html).toContain('238 W (p95 300 W of 350 W)');
  expect(html).toContain('GPU-&lt;a> by GPU UUID: http://gpu-a:11434, http://gpu-a:9000');
  expect(html).toContain('GPU A · primary');
  // A GPU without samples is not shown as idle.
  expect(html).toContain('no sample in this window');
  expect(html).not.toMatch(/GPU 1[\s\S]*?<td>0%<\/td>/);
});

test('says when GPUs cannot be linked to endpoints', () => {
  expect(render({ topology: 'unset', hosts: [] })).toContain('No physical GPU map is configured');
  expect(render({ topology: 'invalid', hosts: [] })).toContain('The physical GPU map is invalid');
  expect(render({ topology: 'configured', unlinkedResources: ['gpu-old'], hosts: [] }))
    .toContain('Not linked to a sampled GPU: gpu-old.');
});
