'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function inbox() {
  const status = { textContent: '' }, count = {}, selection = { value: '' };
  let click, mount;
  const list = { innerHTML: '', addEventListener: (_event, handler) => { click = handler; } };
  const host = { dataset: {}, querySelector: selector => ({
    '[data-ideas-list]': list, '[data-ideas-status]': status, '[data-ideas-count]': count
  })[selector] };
  const fetch = jest.fn(async (_url, options) => ({ ok: true, text: async () => JSON.stringify({ data: options.method === 'POST'
    ? { task: { pipelineId: '0001' } } : { ideas: [{ id: 'synthetic-idea', text: 'Synthetic task', status: 'inbox' }] } }) }));
  const document = {
    documentElement: {}, querySelector: () => null, getElementById: () => null,
    querySelectorAll: selector => selector.startsWith('[data-dad-ideas]') ? [host] : [],
    addEventListener: (_event, callback) => { mount = callback; }
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../../surfaces/household/public/desk-cards.js'), 'utf8');
  vm.runInNewContext(source, { document, fetch, window: {}, MutationObserver: class { observe() {} } });
  mount();
  const promote = async action => {
    const row = { dataset: { idea: 'synthetic-idea' }, querySelector: () => selection };
    const button = { dataset: { ideaAction: action }, closest: () => row };
    await click({ target: { closest: () => button } });
  };
  return { fetch, status, selection, promote };
}

test('Pipeline promotion requires an explicit service and routes Coding Team without launching it', async () => {
  const ui = inbox();
  await ui.promote('task');
  expect(ui.fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(0);
  expect(ui.status.textContent).toContain('Choisissez le service');
  ui.selection.value = 'agentx-coding';
  await ui.promote('task');
  const posts = ui.fetch.mock.calls.filter(([, options]) => options.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0][0]).toBe('/api/family/ideas/synthetic-idea/promote');
  expect(JSON.parse(posts[0][1].body)).toEqual({ targetType: 'task', service: 'agentx-coding' });
  expect(ui.status.textContent).toContain('#0001');
});

test('personal promotion keeps its separate destination regardless of the coding selection', async () => {
  const ui = inbox();
  ui.selection.value = 'agentx-coding';
  await ui.promote('personal');
  const posts = ui.fetch.mock.calls.filter(([, options]) => options.method === 'POST');
  expect(JSON.parse(posts[0][1].body)).toEqual({ targetType: 'personal' });
});
