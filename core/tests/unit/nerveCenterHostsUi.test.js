const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/nerve-center-hosts.js'), 'utf8');
const API = '/api/nerve-center/inference-hosts';

// A submit listener starts its work without returning it: let it settle.
const settle = () => new Promise(resolve => setImmediate(resolve));

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function control(extra = {}) {
  const classes = new Set();
  const node = {
    textContent: '', disabled: false, listeners: {}, dataset: {},
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    addEventListener: (name, listener) => { node.listeners[name] = listener; },
    ...extra
  };
  return node;
}

const ENV_HOST = { id: 'primary', name: 'Tower', url: 'http://192.168.1.20:11434', residency: 'gpu', maxInflight: null, source: 'env', removable: false };
const CPU_HOST = { id: 'frank-cpu', name: 'Tower CPU', url: 'http://192.168.1.20:11435', residency: 'cpu', maxInflight: 1, source: 'registry', removable: true };

// `respond` answers every change request; a GET always lists `hosts`.
async function harness({ hosts = [ENV_HOST, CPU_HOST], respond = async () => ({ status: 'success', data: {} }), confirm } = {}) {
  const summary = control();
  const status = control();
  const submitButton = control();
  const form = control({
    values: {},
    querySelector: selector => (selector === '.nc-host-add-status' ? status : submitButton)
  });
  const inflight = control({ dataset: { hostId: 'frank-cpu' }, value: '8' });
  const removeButton = control({ dataset: { hostId: 'frank-cpu' } });
  const body = {
    innerHTML: '',
    querySelectorAll: selector => ({ '.nc-host-inflight': [inflight], '.nc-host-remove': [removeButton] }[selector] || []),
    querySelector: selector => (selector === '.nc-host-add' ? form : null)
  };
  const fetchJson = jest.fn(async (url, options) => (options ? respond(url, options) : { status: 'success', data: { hosts } }));
  const loadCluster = jest.fn();
  const window = {
    NerveCenterShared: { fetchJson, escapeHtml, renderSectionError(_body, message) { throw new Error(message); }, finishSectionLoad() {} },
    NerveCenterCluster: { loadCluster },
    AgentXTypedConfirmation: { confirm: confirm || (async () => ({ 'X-AgentX-Confirm': 'REMOVE HOST frank-cpu' })) }
  };
  const document = {
    readyState: 'loading', addEventListener() {},
    getElementById: id => (id === 'sectionHostsBody' ? body : id === 'nc-hosts-summary' ? summary : null)
  };
  class FormData {
    constructor(target) { this.target = target; }
    entries() { return Object.entries(this.target.values); }
  }
  vm.runInNewContext(source, { window, document, FormData });
  await window.NerveCenterHosts.loadHosts();
  const lists = () => fetchJson.mock.calls.filter(([, options]) => !options).length;
  return { body, summary, status, submitButton, form, inflight, removeButton, fetchJson, loadCluster, lists };
}

describe('Nerve Center inference hosts UI', () => {
  it('lists each host with its id, origin and the controls it allows', async () => {
    const { body, summary } = await harness();
    expect(body.innerHTML).toContain('<strong>Tower</strong><span class="nc-host-key-badge">primary</span>');
    expect(body.innerHTML).toContain('Configuration file');
    expect(body.innerHTML).toContain('Registered here');
    expect(body.innerHTML).toContain('<code class="nc-hosts-url">http://192.168.1.20:11435</code>');
    expect(body.innerHTML).toContain('aria-label="Concurrent requests on frank-cpu"');
    expect(body.innerHTML).toContain('<option value="0" selected>Default</option>');
    expect((body.innerHTML.match(/class="nc-btn nc-btn-icon nc-btn-danger nc-host-remove"/g) || [])).toHaveLength(1);
    expect((body.innerHTML.match(/class="nc-hosts-locked"/g) || [])).toHaveLength(1);
    expect(body.innerHTML).not.toContain('nc-hosts-notice');
    expect(summary.textContent).toBe('2 hosts · 1 GPU · 1 CPU');
  });

  it('escapes host values and invites the first host when the list is empty', async () => {
    const { body } = await harness({ hosts: [{ ...CPU_HOST, name: '<img src=x>' }] });
    expect(body.innerHTML).toContain('&lt;img src=x&gt;');
    expect(body.innerHTML).not.toContain('<img');
    const empty = await harness({ hosts: [] });
    expect(empty.body.innerHTML).toContain('No host yet: add the first one below.');
    expect(empty.summary.textContent).toBe('No host yet');
  });

  it('shows a refused change and returns the control to the saved value', async () => {
    const { body, inflight, fetchJson, loadCluster, lists } = await harness({
      respond: async () => { throw new Error('Concurrent requests must be between 1 and 16'); }
    });
    await inflight.listeners.change();
    const [url, options] = fetchJson.mock.calls.find(([, options]) => options);
    expect(url).toBe(`${API}/frank-cpu`);
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body)).toEqual({ maxInflight: 8 });
    expect(lists()).toBe(2);
    expect(body.innerHTML).toContain('nc-notice is-error nc-hosts-notice" role="alert"');
    expect(body.innerHTML).toContain('frank-cpu was not changed: Concurrent requests must be between 1 and 16');
    expect(body.innerHTML).toContain('<option value="1" selected>1</option>');
    expect(loadCluster).not.toHaveBeenCalled();
  });

  it('refreshes the cluster and clears the message once a change is accepted', async () => {
    let refuse = true;
    const { body, inflight, loadCluster } = await harness({
      respond: async () => { if (refuse) throw new Error('refused'); return { status: 'success', data: {} }; }
    });
    await inflight.listeners.change();
    expect(body.innerHTML).toContain('nc-hosts-notice');
    refuse = false;
    await inflight.listeners.change();
    expect(body.innerHTML).not.toContain('nc-hosts-notice');
    expect(loadCluster).toHaveBeenCalledTimes(1);
  });

  it('keeps the outcome of an added host visible after the list is redrawn', async () => {
    const { body, form, fetchJson, loadCluster } = await harness({
      respond: async () => ({ status: 'success', data: { reachability: { reachable: false, error: 'timeout' } } })
    });
    form.values = { id: 'ghost', name: 'Ghost', url: 'http://192.168.1.50:11434', residency: 'gpu' };
    await form.listeners.submit({ preventDefault() {}, currentTarget: form });
    await settle();
    const [url, options] = fetchJson.mock.calls.find(([, options]) => options);
    expect(url).toBe(API);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual(form.values);
    expect(body.innerHTML).toContain('nc-notice is-warn nc-hosts-notice" role="alert"');
    expect(body.innerHTML).toContain('ghost was added, but Ollama did not answer (timeout).');
    expect(loadCluster).toHaveBeenCalledTimes(1);
  });

  it('confirms a reachable new host with the Ollama version', async () => {
    const { body, form } = await harness({
      respond: async () => ({ status: 'success', data: { reachability: { reachable: true, version: '0.12.3' } } })
    });
    form.values = { id: 'small', url: 'http://192.168.1.60:11434', residency: 'gpu' };
    await form.listeners.submit({ preventDefault() {}, currentTarget: form });
    await settle();
    expect(body.innerHTML).toContain('nc-notice is-ok nc-hosts-notice" role="status"');
    expect(body.innerHTML).toContain('small was added. Ollama 0.12.3 answered.');
  });

  it('keeps the form as typed when a new host is refused', async () => {
    const { form, status, submitButton, lists, loadCluster } = await harness({
      respond: async () => { throw new Error('Only private network or loopback addresses can be registered'); }
    });
    form.values = { id: 'cloud', url: 'http://8.8.8.8:11434', residency: 'gpu' };
    await form.listeners.submit({ preventDefault() {}, currentTarget: form });
    await settle();
    expect(status.textContent).toBe('Only private network or loopback addresses can be registered');
    expect(status.classList.contains('is-error')).toBe(true);
    expect(submitButton.disabled).toBe(false);
    expect(lists()).toBe(1);
    expect(loadCluster).not.toHaveBeenCalled();
  });

  it('removes a host only after the typed confirmation and reports a refusal', async () => {
    const cancelled = await harness({ confirm: async () => null });
    await cancelled.removeButton.listeners.click();
    expect(cancelled.fetchJson.mock.calls.some(([, options]) => options)).toBe(false);

    const refused = await harness({ respond: async () => { throw new Error("Clear this host's resident models first"); } });
    await refused.removeButton.listeners.click();
    const [url, options] = refused.fetchJson.mock.calls.find(([, options]) => options);
    expect(url).toBe(`${API}/frank-cpu`);
    expect(options).toEqual({ method: 'DELETE', headers: { 'X-AgentX-Confirm': 'REMOVE HOST frank-cpu' } });
    expect(refused.body.innerHTML).toContain("frank-cpu was not removed: Clear this host's resident models first");
    expect(refused.loadCluster).not.toHaveBeenCalled();

    const removed = await harness();
    await removed.removeButton.listeners.click();
    expect(removed.body.innerHTML).toContain('nc-notice is-ok nc-hosts-notice" role="status"');
    expect(removed.body.innerHTML).toContain('frank-cpu was removed.');
    expect(removed.loadCluster).toHaveBeenCalledTimes(1);
  });
});
