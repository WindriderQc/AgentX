const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/nerve-center-runtime-topology.js'), 'utf8');

function card() {
  const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const window = { NerveCenterShared: { escapeHtml, fetchJson: async () => ({}) } };
  vm.runInNewContext(source, { window, Date, globalThis: {}, setTimeout, encodeURIComponent, JSON, Math, Promise });
  return window.NerveCenterRuntimeTopology;
}

const endpoint = (url, role, extra = {}) => ({ url, role, hostName: null, resources: ['gpu-a'], pins: [{ model: 'main:q8', contextSize: 196608 }],
  online: true, pinsResident: true, ready: true, reason: null, ...extra });

function topology(switchInfo, extra = {}) {
  return { configured: true, valid: true, observedAt: new Date().toISOString(), groups: [{
    id: 'dual-gpu', label: 'Dual GPU', activeMode: 'pooled', state: 'active', switch: switchInfo, modes: [
      { id: 'lanes', label: 'Two lanes', status: 'inactive', endpoints: [endpoint('http://h:11437', 'conversation', { ready: false, online: false, reason: 'offline' })] },
      { id: 'pooled', label: 'Pooled', status: 'active', endpoints: [endpoint('http://h:11434', 'pooled')] }
    ], ...extra }] };
}

const record = (state, extra = {}) => ({ requestId: 'sw-1', groupId: 'dual-gpu', fromMode: 'pooled', targetMode: 'lanes', state,
  transitions: ['requested', 'draining', 'actuating', 'loading', 'verifying', 'active']
    .slice(0, ['requested', 'draining', 'actuating', 'loading', 'verifying', 'active'].indexOf(state) + 1 || 3)
    .map(item => ({ state: item, at: new Date().toISOString() })), ...extra });

// A tiny DOM: elements found by id or by class and data-group, with listeners.
function fakeDom(html) {
  const elements = [];
  const make = (cls, group, extra = {}) => {
    const listeners = {};
    const element = { className: cls, dataset: { group }, hidden: cls === 'nc-topology-confirm', disabled: cls === 'nc-topology-confirm-go',
      value: extra.value || '', textContent: '', innerHTML: '',
      addEventListener: (type, fn) => { listeners[type] = fn; }, fire: (type) => listeners[type]?.(),
      querySelector: selector => find(selector) };
    elements.push(element);
    return element;
  };
  const find = selector => {
    const [, cls, group] = selector.match(/^\.([\w-]+)(?:\[data-group="([^"]+)"\])?$/) || [];
    return elements.find(item => item.className === cls && (!group || item.dataset.group === group)) || null;
  };
  const group = 'dual-gpu';
  ['nc-topology-apply', 'nc-topology-confirm', 'nc-topology-phrase', 'nc-topology-phrase-input',
    'nc-topology-confirm-go', 'nc-topology-confirm-cancel'].forEach(cls => make(cls, group));
  make('nc-topology-target', group, { value: 'lanes' });
  const slot = { innerHTML: '' };
  const cardEl = { querySelectorAll: selector => elements.filter(item => `.${item.className}` === selector), querySelector: find };
  return { doc: { getElementById: id => (id === 'ncTopologyCard' ? cardEl : id === 'ncTopologyProgress-dual-gpu' ? slot : null) },
    find, slot, html };
}

describe('Nerve Center runtime topology switch control', () => {
  it('offers no switch when the group has no actuator', () => {
    const html = card().build(topology({ actuatorConfigured: false, intendedMode: 'pooled', inProgress: null, last: null }));
    expect(html).not.toMatch(/<button|<select/);
    expect(html).toContain('no host actuator is configured');
    expect(html).toContain('Current mode: <strong>pooled</strong>');
  });

  it('offers the other modes, an Apply button and a typed confirmation', () => {
    const html = card().build(topology({ actuatorConfigured: true, intendedMode: 'pooled', inProgress: null, last: null }));
    expect(html).toContain('<option value="lanes">Two lanes</option>');
    expect(html).not.toContain('<option value="pooled">');
    expect(html).toContain('nc-topology-apply');
    expect(html).toContain('topology switch in progress');
    expect(html).toContain('(parked)');
    expect(card().confirmationPhrase('dual-gpu', 'lanes')).toBe('SWITCH dual-gpu TO lanes');
  });

  it('disables the control while a switch runs and shows its progress', () => {
    const html = card().build(topology({ actuatorConfigured: true, intendedMode: 'pooled',
      inProgress: { id: 'sw-1', targetMode: 'lanes' }, last: record('loading') }));
    expect(html).toMatch(/nc-topology-target[^>]*disabled/);
    expect(html).toContain('A switch is running.');
    expect(html).toContain('Loading the pinned models …');
    expect(html).toContain('Switching the runtime services ✓');
  });

  it('shows the last receipt with the refusal reason', () => {
    const tool = card();
    const refused = tool.progressHtml(record('refused', { reason: 'host_busy', transitions: [{ state: 'requested' }, { state: 'draining' }, { state: 'refused' }],
      blockers: [{ kind: 'workload', owner: 'benchmark' }] }));
    expect(refused).toContain('Refused (nothing changed)');
    expect(refused).toContain('other work holds the group');
    expect(refused).toContain('workload (benchmark)');
    expect(refused).not.toContain('nc-topology-steps');
    const done = tool.progressHtml(record('active', { finishedAt: new Date().toISOString(), timings: { totalMs: 412000 },
      verification: { residency: [{ ok: true }], smoke: [{ ok: true }], drift: { status: 'ok' } } }));
    expect(done).toContain('all pins on GPU at their context · test answer ok · pin drift ok');
    expect(done).toContain('Took 412 s.');
    const uncertain = tool.progressHtml(record('uncertain', { reason: 'actuator_timeout' }));
    expect(uncertain).toContain('recover the maintenance lease');
  });

  it('refuses a switch when the group has no single running mode', () => {
    const html = card().build(topology({ actuatorConfigured: true, inProgress: null, last: null }, { state: 'transitional', activeMode: null }));
    expect(html).toContain('A switch needs exactly one running mode.');
  });

  it('escapes declared labels and reasons', () => {
    const html = card().progressHtml(record('refused', { reason: '<img src=x>', targetMode: '<b>m</b>' }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;b&gt;m&lt;/b&gt;');
  });

  it('sends the switch only after the exact phrase, then follows it to the end', async () => {
    const tool = card();
    const calls = [];
    const states = ['verifying', 'active'];
    const fetchJson = async (url, options) => {
      calls.push([url, options?.method || 'GET', options?.body ? JSON.parse(options.body) : null]);
      if (options?.method === 'POST') return { status: 'success', data: record('requested') };
      return { status: 'success', data: record(states.shift() || 'active', { finishedAt: new Date().toISOString() }) };
    };
    const dom = fakeDom();
    const toasts = [];
    let reloaded = 0;
    tool.attach(topology({ actuatorConfigured: true, inProgress: null, last: null }), async () => { reloaded += 1; },
      { doc: dom.doc, fetchJson, toast: { success: text => toasts.push(['ok', text]), error: text => toasts.push(['error', text]) } });
    dom.find('.nc-topology-apply').fire('click');
    expect(dom.find('.nc-topology-confirm').hidden).toBe(false);
    expect(dom.find('.nc-topology-phrase').textContent).toBe('SWITCH dual-gpu TO lanes');
    const input = dom.find('.nc-topology-phrase-input');
    input.value = 'switch dual-gpu to lanes';
    input.fire('input');
    expect(dom.find('.nc-topology-confirm-go').disabled).toBe(true);
    input.value = 'SWITCH dual-gpu TO lanes';
    input.fire('input');
    expect(dom.find('.nc-topology-confirm-go').disabled).toBe(false);
    // followSwitch polls every 3 s: shorten by answering the terminal state at once.
    states.length = 0;
    await dom.find('.nc-topology-confirm-go').fire('click');
    expect(calls[0]).toEqual(['/api/nerve-center/runtime-topology/switch', 'POST',
      expect.objectContaining({ groupId: 'dual-gpu', targetMode: 'lanes', expectedActiveMode: 'pooled', requestId: expect.stringMatching(/^nc-/) })]);
    expect(calls[1][0]).toBe('/api/nerve-center/runtime-topology/switch/sw-1');
    expect(dom.slot.innerHTML).toContain('data-switch-state="active"');
    expect(toasts).toEqual([['ok', 'Topology: dual-gpu runs lanes']]);
    expect(reloaded).toBe(1);
  });

  it('keeps the card usable when the switch request is refused', async () => {
    const tool = card();
    const dom = fakeDom();
    const toasts = [];
    tool.attach(topology({ actuatorConfigured: true, inProgress: null, last: null }), async () => {},
      { doc: dom.doc, fetchJson: async () => { throw new Error('Switch sw-0 is verifying'); },
        toast: { success: () => {}, error: text => toasts.push(text) } });
    dom.find('.nc-topology-apply').fire('click');
    const input = dom.find('.nc-topology-phrase-input');
    input.value = 'SWITCH dual-gpu TO lanes';
    input.fire('input');
    await dom.find('.nc-topology-confirm-go').fire('click');
    expect(toasts).toEqual(['Switch sw-0 is verifying']);
    expect(dom.find('.nc-topology-confirm-go').disabled).toBe(false);
  });

  it('follows a switch through missed reads until it ends', async () => {
    const tool = card();
    const answers = [new Error('timeout'), { status: 'success', data: record('loading') }, { status: 'success', data: record('active') }];
    const seen = [];
    const final = await tool.followSwitch(async () => { const next = answers.shift(); if (next instanceof Error) throw next; return next; },
      'sw-1', item => seen.push(item.state), { sleep: async () => {} });
    expect(final.state).toBe('active');
    expect(seen).toEqual(['loading', 'active']);
  });
});
