'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/pipeline-deliverables.js'), 'utf8');

const SHA = 'a'.repeat(64);
function row(id, status, extra = {}) {
  return {
    id, name: `file-${id.slice(-2)}.md`, mimeType: 'text/markdown', size: 2048, sha256: SHA, attempt: null,
    producer: { declared: 'operator', channel: 'operator_api' },
    storage: { status: 'stored', storedAt: '2026-09-27T12:00:00.000Z' },
    availability: { status, hashVerified: status === 'available', checkedAt: '2026-09-27T12:00:00.000Z' },
    externalDelivery: { status: 'none' }, scope: { lane: 'engineering', taskRef: 'task-0307' }, ...extra,
  };
}
function load(fetchImpl) {
  const timers = [];
  const window = {};
  const context = {
    window, fetch: fetchImpl, CSS: { escape: value => value }, navigator: {},
    setTimeout: fn => { timers.push(fn); return timers.length; },
    document: { addEventListener() {}, querySelectorAll: () => [], activeElement: null },
  };
  vm.runInNewContext(source, context);
  return { api: window.PipelineDeliverables, flush: async () => { while (timers.length) await timers.shift()(); } };
}
const ok = data => async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) });

test('the panel loads in the task scope and keeps storage, availability and external delivery apart', async () => {
  const calls = [];
  const rows = [row('0'.repeat(23) + '1', 'present_unverified'), row('0'.repeat(23) + '2', 'available', { attempt: 2, producer: { declared: 'worker-a' } })];
  const { api, flush } = load(async url => { calls.push(url); return ok({ deliverables: rows })(); });
  expect(api.markup({ pipelineId: '0307' })).toContain('Loading deliverables');
  await flush();
  expect(calls).toEqual(['/api/pipeline/tasks/0307/deliverables']);
  const html = api.markup({ pipelineId: '0307' });
  expect(html).toContain('<span class="pipeline-drawer-count">2</span>');
  expect(html).toContain('Stored in Core');
  expect(html).toContain('Stored bytes present · digest not checked yet');
  expect(html).toContain('Available · SHA-256 verified');
  expect(html).toContain('None · Core does not send deliverables to a third party');
  expect(html).toContain('not indexed as memory');
  expect(html).toContain('Attempt 2 · worker-a');
  expect(html.match(/data-download-deliverable=/g)).toHaveLength(2);
  // A fresh list is not fetched again on every re-render.
  api.markup({ pipelineId: '0307' });
  await flush();
  expect(calls).toHaveLength(1);
});

test('missing, altered, unknown and malformed files are never offered for download', async () => {
  const rows = [row('0'.repeat(23) + '1', 'missing'), row('0'.repeat(23) + '2', 'corrupt'),
    row('0'.repeat(23) + '3', 'mystery'), row('not-an-id', 'available'),
    row('0'.repeat(23) + '5', 'available', { name: '<img src=x onerror=alert(1)>.md' })];
  const { api, flush } = load(ok({ deliverables: rows }));
  api.markup({ pipelineId: '0307' });
  await flush();
  const html = api.markup({ pipelineId: '0307' });
  expect(html).toContain('Missing · the stored bytes are gone; not served');
  expect(html).toContain('Altered · the bytes no longer match the SHA-256; not served');
  expect(html).toContain('Unknown availability · not offered for download');
  expect(html).toContain('Unknown deliverable · the record is malformed');
  expect(html.match(/data-download-deliverable=/g)).toHaveLength(1);
  expect(html).not.toContain('<img src=x');
});

test('empty and error states are explicit and the error offers a retry', async () => {
  const empty = load(ok({ deliverables: [] }));
  empty.api.markup({ pipelineId: '0308' });
  await empty.flush();
  expect(empty.api.markup({ pipelineId: '0308' })).toContain('No deliverable is registered for this task.');

  const failing = load(async () => ({ ok: false, status: 503, json: async () => ({ ok: false, message: 'Deliverable registry unavailable' }) }));
  failing.api.markup({ pipelineId: '0309' });
  await failing.flush();
  const html = failing.api.markup({ pipelineId: '0309' });
  expect(html).toContain('Deliverables unavailable: Deliverable registry unavailable');
  expect(html).toContain('data-retry-deliverables="0309"');
  expect(failing.api.markup({ pipelineId: '../x' })).toBe('');
});

test('the main result list offers only valid files and keeps inspection metadata in the technical panel', async () => {
  const records = [row('0'.repeat(23) + '1', 'available', { name: 'review.md' }), row('0'.repeat(23) + '2', 'corrupt'),
    row('0'.repeat(23) + '3', 'missing'), row('0'.repeat(23) + '4', 'unknown'), row('invalid', 'available')];
  const { api, flush } = load(ok({ deliverables: records }));
  api.markup({ pipelineId: '0307' }, { compact: true });
  await flush();
  const main = api.markup({ pipelineId: '0307' }, { compact: true });
  expect(main).toContain('review.md');
  expect(main.match(/data-download-deliverable=/g)).toHaveLength(1);
  expect(main).not.toContain('SHA-256');
  expect(main).not.toContain('External delivery');
  expect(main).toContain('File altered');
  expect(main).toContain('File missing');
  expect(main).toContain('Availability unknown');
  const technical = api.markup({ pipelineId: '0307' });
  expect(technical).toContain('SHA-256');
  expect(technical).toContain('External delivery');
});

test('a newly recorded report refreshes a fresh file cache and an older list response cannot overwrite it', async () => {
  const pending = [], requests = [];
  const { api, flush } = load(url => { requests.push(url); return new Promise(resolve => pending.push(resolve)); });
  api.markup({ pipelineId: '0307' }); const old = flush();
  const candidate = row('0'.repeat(23) + '7', 'available', { name: 'current-report.md',
    reportOrigin: { state: 'candidate' }, producer: { channel: 'report_worker', declared: 'coding-team' } });
  api.markup({ pipelineId: '0307', feedback: [{ reportOutcome: { requestId: 'new-report', sha256: SHA, deliverableId: candidate.id } }] });
  const current = flush();
  expect(requests).toHaveLength(2);
  pending[1]({ ok: true, json: async () => ({ ok: true, data: { deliverables: [candidate] } }) }); await current;
  pending[0]({ ok: true, json: async () => ({ ok: true, data: { deliverables: [] } }) }); await old;
  const task = { pipelineId: '0307', feedback: [{ reportOutcome: { requestId: 'new-report', sha256: SHA, deliverableId: candidate.id } }] };
  expect(api.markup(task, { compact: true })).toContain('current-report.md');
  expect(api.markup(task, { compact: true })).toContain('Report candidate · coverage unverified');
  expect(api.markup(task)).toContain('Native report');
  expect(requests).toHaveLength(2);
});
