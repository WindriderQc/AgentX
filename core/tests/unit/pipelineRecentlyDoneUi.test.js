'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readPipelineScript, loadPipelineParts } = require('../helpers/pipelineScripts');

function load(tasks, search = '') {
  const nodes = { pipelineDoneList: {}, pipelineDoneMeta: {} };
  const context = { window: { location: { search } }, URLSearchParams,
    document: { addEventListener() {}, getElementById: id => nodes[id] || null } };
  loadPipelineParts(context);
  vm.runInNewContext(readPipelineScript().replace(/\}\)\(\);\s*$/, 'globalThis.closedTest = { state, renderRecentlyDone };\n})();'), context);
  const api = context.closedTest;
  api.state.tasks = tasks;
  return { ...api, nodes };
}

function task(n, extra = {}) {
  return { pipelineId: String(n).padStart(4, '0'), title: `Engineering change ${n}`,
    status: 'done', service: 'core', source: 'manual', epic: 'Release',
    updatedAt: `2030-01-${String(n).padStart(2, '0')}T00:00:00Z`, ...extra };
}

test('closed history uses the actual board filters and Agent Ops context', () => {
  const { state, nodes, renderRecentlyDone } = load([
    task(1), task(2, { service: 'benchmark' }), task(3, { status: 'queued' }),
    task(4, { epic: 'Other group' }), task(5, { title: 'Repair cache', source: 'coding-team' }),
  ]);
  state.filters.epic = 'Release';
  state.filters.service = 'core';
  state.filters.lane = 'manual';
  renderRecentlyDone();
  expect(nodes.pipelineDoneList.innerHTML).toContain('data-pipeline-task="0001"');
  for (const n of ['0002', '0003', '0004', '0005']) expect(nodes.pipelineDoneList.innerHTML).not.toContain(`data-pipeline-task="${n}"`);
  state.filters = { search: 'cache' };
  renderRecentlyDone();
  expect(nodes.pipelineDoneList.innerHTML).toContain('data-pipeline-task="0005"');
  expect(nodes.pipelineDoneList.innerHTML).not.toContain('data-pipeline-task="0001"');
  state.context = { task: '0001' };
  state.filters = {};
  renderRecentlyDone();
  expect(nodes.pipelineDoneMeta.textContent).toContain('Latest 1 matching engineering closures');
  expect(nodes.pipelineDoneMeta.textContent).toContain('Closure does not prove deployment');
});

test('closed history excludes archived qualifications until explicitly included, and limits after filtering', () => {
  const rows = Array.from({ length: 10 }, (_, index) => task(index + 1));
  rows.push(task(11, { codingAutonomy: { disposition: { kind: 'qualification', outcome: 'abandoned' } } }));
  const before = JSON.stringify(rows);
  const { state, nodes, renderRecentlyDone } = load(rows);
  renderRecentlyDone();
  expect((nodes.pipelineDoneList.innerHTML.match(/data-pipeline-task=/g) || []).length).toBe(8);
  expect(nodes.pipelineDoneList.innerHTML).not.toContain('data-pipeline-task="0011"');
  expect(nodes.pipelineDoneList.innerHTML.indexOf('0010')).toBeLessThan(nodes.pipelineDoneList.innerHTML.indexOf('0009'));
  state.includeArchivedQualifications = true;
  renderRecentlyDone();
  expect(nodes.pipelineDoneList.innerHTML).toContain('data-pipeline-task="0011"');
  expect(nodes.pipelineDoneList.innerHTML).not.toContain('data-pipeline-task="0003"');
  expect(JSON.stringify(rows)).toBe(before);
});

test('a non-done status filter shows a scoped empty state', () => {
  const { state, nodes, renderRecentlyDone } = load([task(1)]);
  state.filters.status = 'queued';
  renderRecentlyDone();
  expect(nodes.pipelineDoneList.innerHTML).not.toContain('data-pipeline-task=');
  expect(nodes.pipelineDoneMeta.textContent).toBe('No closed engineering tasks match this view.');
});

test('the page explains the engineering scope and links to the personal and family spaces', () => {
  const view = fs.readFileSync(path.resolve(__dirname, '../../views/pages/pipeline.ejs'), 'utf8');
  expect(view).toContain('Coding &amp; delivery pipeline');
  expect(view).toContain('They are excluded from this overview, its counts and its closed-task history.');
  expect(view).toContain('href="/dad/day"');
  expect(view).toContain('href="/dad/family"');
  expect(view).toContain('Recently closed engineering tasks');
});
