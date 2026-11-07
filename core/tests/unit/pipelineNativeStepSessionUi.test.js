'use strict';
const Sessions = require('../../public/js/pipeline-worker-sessions');
const CHILD = '11111111-2222-4333-8444-555555555555';

function documentFixture() {
  const nodes = new Map(), listeners = new Map();
  const document = { addEventListener: jest.fn((kind, callback) => listeners.set(kind, callback)),
    getElementById: id => nodes.get(id) };
  for (const name of ['Dialog', 'Close', 'Select', 'Messages', 'Open', 'Handoff', 'More', 'Title', 'Status']) {
    nodes.set('pipelineNativeSession' + name, { replaceChildren: jest.fn(), options: [],
      addEventListener: jest.fn((kind, callback) => listeners.set('dialog-' + kind, callback)) });
  }
  const dialog = nodes.get('pipelineNativeSessionDialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; listeners.get('dialog-close')?.(); };
  return { document, nodes, listeners, dialog };
}

describe('Core DAG child native conversation', () => {
  let fetch, storage;
  beforeEach(() => {
    jest.useFakeTimers();
    fetch = globalThis.fetch;
    storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {} });
  });
  afterEach(() => {
    globalThis.fetch = fetch;
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage);
    else delete globalThis.localStorage;
    jest.clearAllTimers(); jest.useRealTimers();
  });
  test('one delegated click reads the exact child and selected executor without inference or a duplicate listener', async () => {
    const f = documentFixture();
    globalThis.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ status: 'success',
      data: { pipelineId: '0001', requestId: CHILD, executorId: 'secondary-open', sessions: [] } }) }));
    Sessions.bind(f.document); Sessions.bind(f.document);
    const button = { dataset: { nativeStepPipeline: '0001', nativeStepRequest: CHILD,
      nativeStepExecutor: 'secondary-open' } };
    const event = { target: { closest: () => button }, preventDefault: jest.fn() };
    await f.listeners.get('click')(event);
    expect(f.document.addEventListener).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch.mock.calls[0]).toEqual([
      `/api/runtime-bridges/coding-dispatch/runs/${CHILD}/sessions?pipelineId=0001&executorId=secondary-open`,
      { cache: 'no-store' },
    ]);
    expect(f.dialog.open).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    f.dialog.close();
  });
  test('malformed request targets cannot open a dialog or send a request', () => {
    const f = documentFixture(); globalThis.fetch = jest.fn(); Sessions.bind(f.document);
    const event = { target: { closest: () => ({ dataset: { nativeStepPipeline: '0001',
      nativeStepRequest: '../other-task', nativeStepExecutor: 'secondary-open' } }) }, preventDefault: jest.fn() };
    f.listeners.get('click')(event);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(f.dialog.open).not.toBe(true);
  });
});
