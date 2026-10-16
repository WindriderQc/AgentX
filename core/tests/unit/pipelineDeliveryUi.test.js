'use strict';
const vm = require('node:vm');
const { readPipelineScript } = require('../helpers/pipelineScripts');
const source = readPipelineScript('pipeline-delivery.js');
const SHA = 'a'.repeat(40);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const item = (pipelineId, overrides = {}) => ({ pipelineId, title: `Synthetic task ${pipelineId}`, attempt: 1,
  stage: 'review_ready', humanActionRequired: true,
  summary: { change: 'One fixture file', tests: 'Fixture verification passed', risks: 'Low declared risk', recommendation: 'MERGE', nextAction: 'Review the exact attempt.' }, ...overrides });
const mergeable = () => item('0001', { stage: 'pr_ready_to_merge', pullRequest: { number: 42, headSha: SHA, url: 'https://github.com/synthetic/repository/pull/42' },
  gate: { ready: true, taskAccepted: true, exactPullRequest: true, exactHead: true, sealedReceipt: true, ciGreen: true, mergeable: true } });
function setup(items, counts = { humanActionRequired: items.filter(row => row.humanActionRequired).length, readyToMerge: items.filter(row => row.stage === 'pr_ready_to_merge').length }) {
  const nodes = {}, document = { querySelectorAll: () => [], activeElement: null };
  const $ = id => nodes[id] ||= { innerHTML: '', textContent: '', dataset: {}, events: {},
    addEventListener(name, fn) { this.events[name] = fn; }, querySelector: () => null, focus: jest.fn(), scrollIntoView: jest.fn() };
  const state = {};
  const window = { confirm: jest.fn().mockReturnValue(true) };
  const readProjection = jest.fn().mockResolvedValue({ data: { observedAt: '2026-01-01T12:00:00Z', items, counts } });
  const fetchJson = jest.fn().mockResolvedValue({ data: {} }), loadTasks = jest.fn().mockResolvedValue();
  vm.runInNewContext(source, { window, document, URL, Set });
  const api = window.PipelineDelivery.create({ $, state, escapeHtml: escape, formatDate: value => value,
    DELIVERY_STAGE_META: { review_ready: { label: 'Ready for review', icon: 'fa-search', tone: 'human' }, pr_ready_to_merge: { label: 'Ready to merge', icon: 'fa-check', tone: 'human' } },
    readProjection, fetchJson, loadTasks, toast: jest.fn() });
  api.bindDeliveryNavigation();
  const click = (id, key, value) => nodes[id].events.click({ target: { closest: () => ({ dataset: { [key]: value } }) } });
  return { api, nodes, state, readProjection, fetchJson, window, loadTasks, click };
}

test('pending human review never becomes a merge recommendation or merge control', async () => {
  const { api, nodes } = setup([item('0001')]); await api.loadDeliveryStatus();
  expect(nodes.pipelineDeliveryList.innerHTML).toContain('Review result');
  expect(nodes.pipelineDeliveryList.innerHTML).toContain('Human review required before acceptance or merge.');
  expect(nodes.pipelineDeliveryList.innerHTML).not.toContain('>MERGE<');
  expect(nodes.pipelineDeliveryList.innerHTML).not.toContain('data-delivery-merge');
  expect(nodes.pipelineDeliveryHumanCount.textContent).toBe('1 decision');
  expect(nodes.pipelineDeliveryMeta.textContent).toContain('independent of overview filters');
});

test('all records stay reachable through pages, including qualification-like titles and unknown stages', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => item(String(index + 1).padStart(4, '0')));
  rows[11].title = 'Synthetic qualification remains an inspectable record';
  rows[11].stage = 'future_stage'; delete rows[11].humanActionRequired;
  const { api, nodes, click } = setup(rows); await api.loadDeliveryStatus();
  const seen = () => [...nodes.pipelineDeliveryList.innerHTML.matchAll(/data-delivery-item="([^"]+)"/g)].map(match => match[1]);
  const all = [...seen()]; expect(all).toHaveLength(5);
  click('pipelineDeliveryPager', 'deliveryPage', 'next'); all.push(...seen());
  click('pipelineDeliveryPager', 'deliveryPage', 'next'); all.push(...seen());
  expect(all).toEqual(rows.map(row => row.pipelineId));
  expect(nodes.pipelineDeliveryPager.innerHTML).toContain('11–12 of 12');
  expect(nodes.pipelineDeliveryList.innerHTML).toContain('Synthetic qualification remains');
});

test('decision and follow-up views use the received action flag and leave completed deliveries in history', async () => {
  const { api, nodes, click } = setup([item('0001'), item('0002', { stage: 'ci_running', humanActionRequired: false }), item('0003', { stage: 'deployed', humanActionRequired: false })]);
  await api.loadDeliveryStatus();
  expect(nodes.pipelineDeliveryHistoryList.innerHTML).toContain('Synthetic task 0003');
  expect(nodes.pipelineDeliveryList.innerHTML).not.toContain('Synthetic task 0003');
  click('pipelineDeliveryViews', 'deliveryView', 'decisions');
  expect(nodes.pipelineDeliveryList.innerHTML).toContain('Synthetic task 0001');
  expect(nodes.pipelineDeliveryList.innerHTML).not.toContain('Synthetic task 0002');
  click('pipelineDeliveryViews', 'deliveryView', 'progress');
  expect(nodes.pipelineDeliveryList.innerHTML).toContain('Synthetic task 0002');
  expect(nodes.pipelineDeliveryList.innerHTML).not.toContain('Synthetic task 0001');
});

test('absent decision totals remain unknown', async () => {
  const { api, nodes } = setup([item('0001')], {}); await api.loadDeliveryStatus();
  expect(nodes.pipelineDeliveryHumanCount.textContent).toBe('Unknown decisions');
  expect(nodes.pipelineDeliveryState.innerHTML).toContain('Decision total unknown');
  expect(nodes.pipelineDeliveryState.innerHTML).toContain('merge readiness unknown');
});

test('a failed read retains the observed rows and disables merge', async () => {
  const { api, nodes, readProjection, fetchJson } = setup([mergeable()]); await api.loadDeliveryStatus();
  expect(nodes.pipelineDeliveryList.innerHTML).toContain('data-delivery-merge');
  readProjection.mockRejectedValueOnce(new Error('Synthetic outage')); await api.loadDeliveryStatus();
  expect(nodes.pipelineDeliveryList.innerHTML).toContain('Synthetic task 0001');
  expect(nodes.pipelineDeliveryList.innerHTML).not.toContain('data-delivery-merge');
  expect(nodes.pipelineDeliveryState.innerHTML).toContain('Last observation retained');
  await api.mergeDeliveryItem({ dataset: { pipelineId: '0001', prNumber: '42', headSha: SHA } });
  expect(fetchJson).not.toHaveBeenCalled();
});

test('a malformed response retains known evidence instead of inventing an empty delivery list', async () => {
  const { api, nodes, readProjection } = setup([item('0001')]); await api.loadDeliveryStatus();
  readProjection.mockResolvedValueOnce({ data: { counts: { humanActionRequired: 0 } } });
  await api.loadDeliveryStatus();
  expect(nodes.pipelineDeliveryList.innerHTML).toContain('Synthetic task 0001');
  expect(nodes.pipelineDeliveryState.innerHTML).toContain('unknown format');
  expect(nodes.pipelineDeliveryHumanCount.textContent).toBe('Unknown');
});

test('a duplicate merge click sends one exact-identity request and never merges from a loading view', async () => {
  const { api, state, fetchJson, window } = setup([mergeable()]); await api.loadDeliveryStatus();
  const button = { dataset: { pipelineId: '0001', prNumber: '42', headSha: SHA } };
  state.deliveryLoading = true; await api.mergeDeliveryItem(button); expect(fetchJson).not.toHaveBeenCalled();
  state.deliveryLoading = false;
  let finish; fetchJson.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = api.mergeDeliveryItem(button); await api.mergeDeliveryItem(button);
  expect(fetchJson).toHaveBeenCalledTimes(1); expect(window.confirm).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchJson.mock.calls[0][1].body)).toEqual({ pipelineId: '0001', pullRequestNumber: 42, expectedHeadSha: SHA, confirmation: `MERGE PR #42 @ ${SHA}` });
  finish({ data: {} }); await first;
});

test('delivery labels escape markup and reject non-GitHub expert links', async () => {
  const { api, nodes } = setup([item('0001', { title: '<img src=x onerror=syntheticInjection>', summary: { change: '<script>syntheticInjection</script>', nextAction: 'Inspect <evidence>' }, pullRequest: { url: 'javascript:syntheticInjection' } })]);
  await api.loadDeliveryStatus();
  expect(nodes.pipelineDeliveryList.innerHTML).toContain('&lt;img');
  expect(nodes.pipelineDeliveryList.innerHTML).not.toContain('<img');
  expect(nodes.pipelineDeliveryList.innerHTML).not.toContain('<script>');
  expect(nodes.pipelineDeliveryList.innerHTML).not.toContain('href="javascript:');
});
