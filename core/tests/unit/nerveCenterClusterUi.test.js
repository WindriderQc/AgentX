const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '../../public/js/nerve-center-cluster.js'),
  'utf8'
);

describe('Nerve Center cluster UI', () => {
  it('uses the host-preference live observation instead of manufacturing an empty loaded-model list', () => {
    expect(source).toContain('pref?.live?.runningModels');
    expect(source).toContain('preferenceRunningModels.length > 0');
    expect(source).not.toContain('ollamaRunningModels: []');
  });

  it('derives loaded-model VRAM and exposes the observation timestamp', () => {
    expect(source).toContain('model?.sizeVram ?? model?.size_vram');
    expect(source).toContain('pref?.live?.observedAt');
  });
});

describe('Nerve Center individual pin controls', () => {
  const hostUrl = 'http://host:11434';
  const primary = { model: 'gemma:latest', keepAlive: 300, contextSize: 32768, autoRestore: false };
  const embedding = { model: 'qllama/bge-m3:f16', keepAlive: -1, contextSize: 0, autoRestore: true };

  async function controlHarness(selector, { model, value, checked, removing = false, ollamaConcurrency = null, gpuRows = [], modelParallelism } = {}) {
    const body = { innerHTML: '' };
    const listeners = {};
    const control = {
      dataset: { hostUrl, model }, value, checked, disabled: false,
      addEventListener: (name, listener) => { listeners[name] = listener; },
      classList: { contains: () => removing }
    };
    const responses = {
      '/api/ollama-hosts': { data: { hosts: [{ id: 'primary', name: 'Host', url: hostUrl, available: true,
        models: [], runningModels: [] }] } },
      '/api/nerve-center/host-preferences': { data: [{ hostUrl, pinnedModels: [primary, embedding],
        maxConcurrentModels: 2, ollamaConcurrency, status: 'ready', live: { runningModels: [{ name: embedding.model }, { name: primary.model }], modelParallelism } }] },
      '/api/nerve-center/inference/gpu-status': { data: gpuRows }
    };
    const fetchJson = jest.fn(async (url, options) => options ? { status: 'success' } : responses[url]);
    const window = { NerveCenterShared: {
      fetchJson, escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, ''), shortModel: value => value,
      renderSectionLoading() {}, renderSectionError(_element, error) { throw new Error(error); }, finishSectionLoad() {},
      timeAgo: () => '', formatUptime: () => ''
    } };
    const document = {
      getElementById: () => body,
      querySelectorAll: query => query === selector ? [control] : [],
      querySelector: () => ({ value: 'another-model:latest' })
    };
    vm.runInNewContext(source, { window, document, console, URL, Map, Set, CSS: { escape: value => value } });
    await window.NerveCenterCluster.loadCluster();
    window.NerveCenterCluster.loadCluster = jest.fn();
    return { body, listeners, fetchJson };
  }

  it('shows both residents and independent keep-alive and auto-restore options', async () => {
    const { body } = await controlHarness('unused');
    expect(body.innerHTML).toContain('2/2 loaded');
    expect(body.innerHTML).toContain('Keep alive for gemma:latest');
    expect(body.innerHTML).toContain('Keep alive for qllama/bge-m3:f16');
    expect(body.innerHTML).toContain('Resident slots');
    expect(body.innerHTML).toContain('32768');
    expect(body.innerHTML).not.toContain('phantom-loading');
  });

  it('adds a model without resubmitting the complete pin list', async () => {
    const { listeners, fetchJson } = await controlHarness('.nc-pref-add-default, .nc-pref-remove-default');
    await listeners.click();
    const [, options] = fetchJson.mock.calls.find(([, options]) => options);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ model: 'another-model:latest' });
  });

  it('shows the observed request limit independently from resident slots', async () => {
    const { body } = await controlHarness('unused', { ollamaConcurrency: {
      numParallel: 4, observedAt: new Date(Date.now() - 2 * 86400000).toISOString(), source: 'startup-log'
    } });
    expect(body.innerHTML).toContain('Parallel requests per model');
    expect(body.innerHTML).toContain('4 configured');
    expect(body.innerHTML).toContain('Last observed:');
    expect(body.innerHTML).toContain('2d old');
    expect(body.innerHTML).toContain('Extra requests queue.');
    expect(body.innerHTML).toContain('Resident slots');
  });

  it.each([null, { numParallel: 4, observedAt: 'invalid' }, {
    numParallel: 4, observedAt: new Date(Date.now() + 86400000).toISOString()
  }])('does not invent a request limit for missing or invalid observations (%j)', async ollamaConcurrency => {
    const { body } = await controlHarness('unused', { ollamaConcurrency });
    expect(body.innerHTML).toContain('Parallel requests per model</span> · <strong>Unknown');
    expect(body.innerHTML).not.toContain('Last observed:');
  });

  describe('effective request slots per model', () => {
    const modelParallelism = [
      { model: 'synthetic-qwen:27b', family: 'qwen35', architecture: 'qwen35', requestSlots: 1, reason: 'architecture' },
      { model: embedding.model, family: 'bert', architecture: 'bert', requestSlots: 1, reason: 'no_completion' },
      { model: primary.model, family: 'gemma3', architecture: 'gemma3', requestSlots: null, reason: 'server_setting' },
      { model: 'unreadable:latest', family: null, architecture: null, requestSlots: null, reason: 'unknown' }
    ];

    it('shows the slot Ollama forces and the configured value for other models', async () => {
      const { body } = await controlHarness('unused', { modelParallelism, ollamaConcurrency: {
        numParallel: 4, observedAt: new Date(Date.now() - 86400000).toISOString(), source: 'startup-log'
      } });
      expect(body.innerHTML).toContain('Parallel requests per model</span> · <strong>4 configured');
      expect(body.innerHTML).toContain('synthetic-qwen:27b</span> <strong>1 (architecture qwen35)');
      expect(body.innerHTML).toContain('qllama/bge-m3:f16</span> <strong>1 (embedding model)');
      expect(body.innerHTML).toContain('gemma:latest</span> <strong>4 (server setting)');
      expect(body.innerHTML).toContain('unreadable:latest</span> <strong>unknown');
    });

    it('does not invent a value for models that follow an unknown server setting', async () => {
      const { body } = await controlHarness('unused', { modelParallelism });
      expect(body.innerHTML).toContain('synthetic-qwen:27b</span> <strong>1 (architecture qwen35)');
      expect(body.innerHTML).toContain('gemma:latest</span> <strong>server setting');
    });

    it('omits the line when no model was described', async () => {
      const { body } = await controlHarness('unused');
      expect(body.innerHTML).not.toContain('Effective</span>');
    });
  });

  describe('Ollama server settings read by the GPU collector', () => {
    const observedAt = () => new Date(Date.now() - 3 * 60000).toISOString();
    const settingsRow = environment => [{ hostId: 'primary', telemetry: { status: 'fresh', ageMs: 4000 }, gpus: [],
      ollamaEnvironment: { source: 'systemd', unit: 'ollama.service', observedAt: observedAt(), ...environment } }];

    it('shows the observed settings, Ollama defaults for unset keys and their source', async () => {
      const { body } = await controlHarness('unused', { gpuRows: settingsRow({
        ok: true, values: { OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_NUM_PARALLEL: '1', CUDA_VISIBLE_DEVICES: '0,1' },
        rejectedKeys: [], activeSince: 'Sat 2026-10-03 21:14:02 EDT', needDaemonReload: true, environmentFiles: false
      }) });
      expect(body.innerHTML).toContain('Ollama server settings');
      expect(body.innerHTML).toContain('KV cache</span> <strong>q8_0');
      expect(body.innerHTML).toContain('Flash attention</span> <strong>Ollama default');
      expect(body.innerHTML).toContain('Visible GPUs</span> <strong>0,1');
      expect(body.innerHTML).toContain('Read by the GPU collector from the systemd unit ollama.service · 3 min ago');
      expect(body.innerHTML).toContain('systemd has not reloaded it');
      // Without a recorded observation, the parallel-request line uses the collector's reading.
      expect(body.innerHTML).toContain('Parallel requests per model</span> · <strong>1 configured');
      expect(body.innerHTML).not.toContain('Parallel requests</span> <strong>');
    });

    it('keeps a recorded parallel-request observation and still shows the collector reading', async () => {
      const { body } = await controlHarness('unused', {
        ollamaConcurrency: { numParallel: 4, observedAt: new Date(Date.now() - 86400000).toISOString(), source: 'startup-log' },
        gpuRows: settingsRow({ ok: true, values: { OLLAMA_NUM_PARALLEL: '1' }, rejectedKeys: [] })
      });
      expect(body.innerHTML).toContain('Parallel requests per model</span> · <strong>4 configured');
      expect(body.innerHTML).toContain('Parallel requests</span> <strong>1');
    });

    it('states a failed read instead of showing defaults', async () => {
      const { body } = await controlHarness('unused', { gpuRows: settingsRow({ ok: false, error: 'Permission denied (publickey).' }) });
      expect(body.innerHTML).toContain('Ollama server settings</span> · <strong>not read');
      expect(body.innerHTML).toContain('Permission denied (publickey).');
      expect(body.innerHTML).not.toContain('KV cache');
      expect(body.innerHTML).toContain('Parallel requests per model</span> · <strong>Unknown');
    });

    it('shows nothing when the collector does not read the service', async () => {
      const { body } = await controlHarness('unused', { gpuRows: [{ hostId: 'primary', telemetry: { status: 'fresh' }, gpus: [] }] });
      expect(body.innerHTML).not.toContain('Ollama server settings');
    });
  });

  it('changes embedding keep-alive without overwriting the conversation pin', async () => {
    const { listeners, fetchJson } = await controlHarness('.nc-pref-keepalive-select', { model: embedding.model, value: '600' });
    await listeners.change();
    const [, options] = fetchJson.mock.calls.find(([, options]) => options);
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body)).toEqual({ model: embedding.model, keepAlive: 600 });
  });

  it('removes only the requested pin', async () => {
    const { listeners, fetchJson } = await controlHarness('.nc-pref-add-default, .nc-pref-remove-default', { model: embedding.model, removing: true });
    await listeners.click();
    const [, options] = fetchJson.mock.calls.find(([, options]) => options);
    expect(options.method).toBe('DELETE');
    expect(JSON.parse(options.body)).toEqual({ model: embedding.model });
  });
});

describe('Nerve Center cluster GPU telemetry', () => {
  function renderCluster(gpuRows) {
    const body = { innerHTML: '' };
    const responses = {
      '/api/ollama-hosts': { data: { hosts: [
        { id: 'primary', name: 'Primary', url: 'http://primary:11434', available: true },
        { id: 'secondary', name: 'Secondary', url: 'http://secondary:11434', available: true }
      ] } },
      '/api/nerve-center/host-preferences': { data: [] },
      '/api/nerve-center/inference/gpu-status': { data: gpuRows }
    };
    const shared = {
      fetchJson: async (url) => responses[url],
      escapeHtml: (value) => String(value ?? '').replace(/[&<>"']/g, ''),
      renderSectionLoading() {}, renderSectionError(_el, message) { throw new Error(message); }, finishSectionLoad() {},
      shortModel: (name) => name, timeAgo: () => 'just now', formatUptime: () => ''
    };
    const window = { NerveCenterShared: shared };
    const document = { getElementById: () => body, querySelectorAll: () => [] };
    vm.runInNewContext(source, { window, document, console, URL, Map, Set });
    return window.NerveCenterCluster.loadCluster().then(() => body.innerHTML);
  }

  it('shows fresh collector values and marks a stale host without its old numbers', async () => {
    const html = await renderCluster([
      { hostId: 'primary', telemetry: { status: 'fresh', ageMs: 4000 }, gpus: [
        { index: 0, name: 'Synthetic GPU', temperature: 61, utilization: 64, vramUsed: 9000, vramTotal: 24576,
          powerDraw: 210, powerLimit: 350, throttleReasons: ['hw_thermal'] }
      ] },
      { hostId: 'secondary', telemetry: { status: 'stale', ageMs: 3600000, lastError: 'ssh timed out' }, gpus: [] }
    ]);
    const [primary, secondary] = html.split('data-host="secondary"');
    expect(primary).toContain('live · 4s');
    expect(primary).toContain('61°C');
    expect(primary).toContain('210W / 350W');
    expect(primary).toContain('THROTTLED');
    expect(secondary).toContain('GPU data stale · 60 min');
    expect(secondary).toContain('ssh timed out');
    expect(secondary).not.toContain('°C');
  });

  it('keeps rendering the cluster when GPU telemetry is unavailable', async () => {
    const html = await renderCluster([
      { hostId: 'primary', telemetry: { status: 'unavailable', lastError: 'Data request timed out' }, gpus: [] }
    ]);
    expect(html).toContain('GPU telemetry unavailable');
    expect(html).toContain('data-host="secondary"');
  });
});
