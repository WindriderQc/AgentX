'use strict';

// Nerve Center task routing editor: role targets (#360, phase 2) appear only
// when a runtime topology is declared.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/nerve-center-routing.js'), 'utf8');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function baseConfig(extra = {}) {
  return {
    hosts: { primary: 'http://primary:11434', secondary: 'http://secondary:11434' },
    taskModels: {},
    taskMetadata: { analysis: { title: 'Analysis' }, summarization: { title: 'Summarization' } },
    availableModels: ['model-a', 'model-b'],
    defaults: { taskModels: {} },
    taskConfigState: {
      analysis: { default: { model: 'model-a', host: 'primary' }, effective: { model: 'model-a', host: 'primary' }, isOverride: false },
      summarization: { default: { model: 'model-a', host: 'primary' }, effective: { model: 'model-b', host: 'secondary' }, isOverride: true }
    },
    ...extra
  };
}

async function render(config, { hostValue = 'secondary' } = {}) {
  const body = { innerHTML: '' };
  const listeners = {};
  const fetchJson = jest.fn(async (url) => {
    if (url.startsWith('/api/router/config/tasks/')) return { status: 'success' };
    if (url.includes('principal-model')) return { status: 'error' };
    return { status: 'success', data: url.includes('routing/log') ? [] : {} };
  });
  const window = {
    NerveCenterShared: {
      escapeHtml, fetchJson,
      shortModel: model => String(model),
      sortHostKeys: keys => [...keys].sort(),
      hostKeyFromUrl: () => 'primary',
      renderSectionLoading: () => {}, renderSectionError: (_el, message) => { throw new Error(message); },
      finishSectionLoad: () => {}, attachCollapsibleHandlers: () => {}, invalidateEcosystemSnapshot: () => {},
      getEcosystemSnapshot: async () => ({ routingConfig: config, routing: { isFailedOver: false } })
    },
    NerveCenterPrincipalModel: { build: () => '', attach: () => {} },
    NerveCenterRuntimeTopology: { build: () => '' },
    NerveCenter: { loadRouting: async () => {} }
  };
  const element = (selector) => ({
    dataset: { task: 'summarization' },
    value: selector.includes('host') ? hostValue : 'model-a',
    disabled: false,
    addEventListener: (type, fn) => { listeners[`${selector}:${type}`] = fn; }
  });
  const document = {
    getElementById: id => (id === 'sectionRoutingBody' ? body : null),
    querySelectorAll: selector => (['.nc-task-save', '.nc-task-host-select'].includes(selector) ? [element(selector)] : []),
    querySelector: selector => element(selector)
  };
  vm.runInNewContext(source, { window, document, Toast: { success: () => {}, error: () => {} }, console });
  await window.NerveCenterRouting.loadRouting();
  const save = async () => {
    await listeners['.nc-task-save:click']();
    const call = fetchJson.mock.calls.find(([url]) => url.startsWith('/api/router/config/tasks/'));
    return JSON.parse(call[1].body);
  };
  return { html: body.innerHTML, save, listeners };
}

const TOPOLOGY = {
  declared: true, valid: true, roles: ['conversation', 'background', 'pooled'],
  groups: [{ id: 'dual-gpu', label: 'Dual GPU' }], principal: null, resolutions: {}
};

describe('task routing editor role targets', () => {
  it('offers hosts only, and saves model and host, when no topology is declared', async () => {
    const { html, save } = await render(baseConfig());
    expect(html).not.toContain('Role:');
    expect(html).toContain('<th>Host</th>');
    await expect(save()).resolves.toEqual({ model: 'model-a', host: 'secondary' });
  });

  it('offers each role next to the hosts when a topology is declared', async () => {
    const { html } = await render(baseConfig({ topology: TOPOLOGY }));
    expect(html).toContain('<th>Host or role</th>');
    for (const role of ['conversation', 'background', 'pooled']) {
      expect(html).toContain(`<option value="role::${role}" >Role: ${role}</option>`);
    }
  });

  it('shows the resolved endpoint of a role route and disables its model choice', async () => {
    const config = baseConfig({ topology: { ...TOPOLOGY, resolutions: {
      summarization: { ok: true, role: 'background', mode: 'lanes', host: 'lane-b', url: 'http://h:11438', model: 'lane-pin', laneContext: 98304 }
    } } });
    config.taskConfigState.summarization.effective = { model: null, host: null, role: 'background' };
    const { html } = await render(config);
    expect(html).toContain('<option value="role::background" selected>Role: background</option>');
    expect(html).toContain('Resolves to LANE-B in mode lanes · pin lane-pin · 98304 ctx');
    expect(html).toContain('<option value="" selected>Endpoint pin</option>');
    expect(html).toMatch(/aria-label="Model for summarization" style="min-width:210px;" disabled>/);
  });

  it('shows the reason when a role route does not resolve', async () => {
    const config = baseConfig({ topology: { ...TOPOLOGY, resolutions: {
      summarization: { ok: false, role: 'background', mode: 'pooled', reason: 'role_not_in_active_mode' }
    } } });
    config.taskConfigState.summarization.effective = { model: null, host: null, role: 'background' };
    const { html } = await render(config);
    expect(html).toContain('Not resolved: role_not_in_active_mode · requests are refused, not rerouted');
  });

  it('saves a role without model or host', async () => {
    const { save } = await render(baseConfig({ topology: TOPOLOGY }), { hostValue: 'role::conversation' });
    await expect(save()).resolves.toEqual({ role: 'conversation' });
  });

  it('names the group when several topology groups are declared', async () => {
    const topology = { ...TOPOLOGY, groups: [{ id: 'dual-gpu', label: 'Dual GPU' }, { id: 'other', label: 'Other' }] };
    const { html, save } = await render(baseConfig({ topology }), { hostValue: 'role:other:pooled' });
    expect(html).toContain('Role: pooled (Other)');
    await expect(save()).resolves.toEqual({ role: 'pooled', group: 'other' });
  });
});
