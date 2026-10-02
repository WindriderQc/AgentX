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
