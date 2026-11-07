'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/nerve-center-health.js'), 'utf8');
const view = fs.readFileSync(path.join(__dirname, '../../views/pages/nerve-center.ejs'), 'utf8');
const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function setup(response) {
  const body = { innerHTML: '' };
  const shared = { escapeHtml, fetchJson: jest.fn(async () => response), renderSectionLoading: jest.fn(),
    renderSectionError: jest.fn(), finishSectionLoad: jest.fn() };
  const context = { window: { NerveCenterShared: shared }, document: { getElementById: () => body }, setInterval: jest.fn(() => 1), console };
  vm.runInNewContext(source, context);
  return { api: context.window.NerveCenterHealth, body, shared, context };
}

test('keeps the new view in Diagnostics and preserves the action-first alert feed', () => {
  expect(view).toMatch(/class="nc-section nc-detail-only" id="sectionAutomations"/);
  expect(view.indexOf('id="sectionAutomations"')).toBeGreaterThan(view.indexOf('id="sectionHealth"'));
  expect(source).toContain('Completed receipts and history');
});

test('shows disabled configuration, dated result, provenance, gaps and manual links with escaped content', async () => {
  const at = '2026-10-01T11:00:00.000Z';
  const { api, body, shared } = setup({ data: { observedAt: at, scope: 'Read only',
    sources: { alerts: { status: 'unavailable' }, rules: { status: 'available', truncated: true } },
    rows: [{ name: '<script>bad()</script>', mode: 'detection', enabled: false, running: false, configurationSource: 'AlertRule',
      last: { timestamp: at, outcome: 'detected', source: 'Alert', id: 'synthetic-id', event: 'synthetic_fault', freshness: 'historical',
        origin: 'autonomous', operationId: 'synthetic-execution' },
      operator: { label: 'Rules', href: '/nerve-center#sectionAlerts' } }],
    manual: [{ name: 'Model reload', operator: { label: 'Pins', href: '/nerve-center#sectionCluster' } }] } });
  await api.loadAutomations();
  expect(shared.fetchJson).toHaveBeenCalledWith('/api/nerve-center/self-healing');
  expect(shared.fetchJson).toHaveBeenCalledTimes(1);
  expect(body.innerHTML).toContain('Disabled');
  expect(body.innerHTML).toContain('Detection only');
  expect(body.innerHTML).toContain(`datetime="${at}"`);
  expect(body.innerHTML).toContain('synthetic-id');
  expect(body.innerHTML).toContain('synthetic_fault');
  expect(body.innerHTML).toContain('Origin: autonomous');
  expect(body.innerHTML).toContain('Execution: synthetic-execution');
  expect(body.innerHTML).toContain('historical');
  expect(body.innerHTML).toContain('alerts: unavailable');
  expect(body.innerHTML).toContain('rules: partial coverage');
  expect(body.innerHTML).toContain('Manual');
  expect(body.innerHTML).toContain('href="/nerve-center#sectionCluster"');
  expect(body.innerHTML).not.toContain('<script>');
  expect(body.innerHTML).toContain('&lt;script&gt;');
});

test('failed reads say unknown and a successful refresh replaces old evidence', async () => {
  const { api, shared, body, context } = setup(null);
  await api.loadAutomations();
  expect(shared.renderSectionError).toHaveBeenCalledWith(body, expect.stringContaining('unknown'));
  shared.fetchJson.mockResolvedValue({ data: { rows: [{ name: 'Action', mode: 'autonomous', enabled: null, last: { outcome: 'unknown' } }] } });
  await api.loadAutomations();
  expect(body.innerHTML).toContain('Autonomous action');
  expect(body.innerHTML).toContain('Not observed');
  expect(body.innerHTML).toContain('unknown');
  expect(context.setInterval).toHaveBeenCalledTimes(1);
});

test('rejects unsafe operator links and does not render execution buttons', () => {
  const { api } = setup(null);
  const html = api.renderAutomations({ manual: [{ name: 'Manual', operator: { label: 'Unsafe', href: 'javascript:bad()' } }] });
  expect(html).not.toContain('javascript:');
  expect(html).not.toContain('<button');
});

test('operator links open collapsed destinations through the existing controller', async () => {
  const { api, body, context } = setup({ data: { rows: [] } });
  await api.loadAutomations();
  const section = { classList: { contains: () => true } };
  context.document.getElementById = () => section;
  context.window.NerveCenter = { toggleSection: jest.fn() };
  body.onclick({ target: { closest: () => ({ getAttribute: () => '/nerve-center#sectionCluster' }) } });
  expect(context.window.NerveCenter.toggleSection).toHaveBeenCalledWith('sectionCluster');
});
