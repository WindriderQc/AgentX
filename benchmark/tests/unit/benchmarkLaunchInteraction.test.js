const vm = require('vm');
const { batchConfigScript } = require('../helpers/batchConfigSource');

function loadLaunch(profilingCheck) {
  const source = batchConfigScript();
  const button = { disabled: false, textContent: '', style: {} };
  const error = { textContent: '', style: {} };
  const container = {
    dataset: {},
    querySelector: selector => selector === '#bv2-form-error' ? error : null,
    querySelectorAll: () => [{ value: 'test-model', dataset: {} }],
    dispatchEvent: jest.fn()
  };
  const context = vm.createContext({
    document: { querySelector: () => button, getElementById: () => null },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    fetchActiveProfilingState: profilingCheck,
    findProfilingForHost: () => [{ profileId: 'busy' }],
    formatProfilingLockout: () => 'Host is busy'
  });
  vm.runInContext(source + `
    _currentHost = { hostUrl: 'http://127.0.0.1:11434' };
    globalThis.launch = _handleLaunch;
  `, context);
  return { launch: () => context.launch(container, null, jest.fn()), button, error };
}

test('repeated launch while the initial check is pending makes only one request', async () => {
  let resolve;
  const check = jest.fn(() => new Promise(done => { resolve = done; }));
  const ui = loadLaunch(check);
  const first = ui.launch();
  expect(ui.button.disabled).toBe(true);
  await ui.launch();
  expect(check).toHaveBeenCalledTimes(1);
  resolve({});
  await first;
  expect(ui.button.disabled).toBe(false);
  expect(ui.error.textContent).toContain('Host is busy');
});

test('a failed initial check restores the action and allows a later retry', async () => {
  const check = jest.fn().mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue({});
  const ui = loadLaunch(check);
  await ui.launch();
  expect(ui.button.disabled).toBe(false);
  expect(ui.error.textContent).toContain('Connection lost');
  await ui.launch();
  expect(check).toHaveBeenCalledTimes(2);
  expect(ui.button.disabled).toBe(false);
  expect(ui.error.textContent).toContain('Host is busy');
});

test('preflight shows each candidate response budget and the judge window (#397)', () => {
  const source = batchConfigScript();
  let inserted = null;
  const error = { parentNode: { insertBefore: node => { inserted = node; } } };
  const container = { querySelector: selector => (selector === '#bv2-form-error' ? error : null) };
  const context = vm.createContext({
    document: { createElement: () => ({ style: {} }), querySelector: () => null, getElementById: () => null },
    esc: value => String(value),
  });
  vm.runInContext(source + '\nglobalThis.showBudgets = _showBudgetSummary;', context);
  context.showBudgets(container, { checks: { budgets: {
    candidates: [
      { model: 'model-a', num_ctx: 65536, num_predict: 32000, num_predict_source: 'documented_default_half_window_v1' },
      { model: 'model-b', num_ctx: null, num_predict: null, error: 'Context not verified' },
    ],
    judge: { model: 'judge-model', num_ctx: 131072 },
  } } });
  expect(inserted.id).toBe('bv2-preflight-budgets');
  expect(inserted.innerHTML).toContain('model-a: answers up to 32,000 tokens (documented default, at most half the window) in a 65,536-token window');
  expect(inserted.innerHTML).toContain('Judge judge-model reads a 131,072-token window');
  expect(inserted.innerHTML).not.toContain('model-b');
});
